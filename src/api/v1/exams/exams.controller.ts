import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  type Exam,
  type ExamResult,
  ExamStatus,
  type ExamTest,
  Prisma,
  Role,
  SourceType,
  TransactionStatus,
  TransactionType,
} from "../../../../generated/prisma";
import { db } from "../../../database/db";
import { buildQueryOptions } from "../../../helpers/query-helper";
import {
  invalidateInventoryRelatedCaches,
  invalidateVisitRelatedCaches,
} from "../../../lib/cache-utils";
import { searchParamsSchema } from "../../../lib/common-validation";
import { httpCodes } from "../../../lib/constants";
import {
  createExamResultSchema,
  createExamSchema,
  createExamTestSchema,
  updateExamResultSchema,
  updateExamSchema,
  updateExamTestConsumablesSchema,
  updateExamTestNormalRangeSchema,
  updateExamTestSchema,
  updateExamTestUnitsSchema,
} from "./exams.validation";

export const getExams = async (c: Context) => {
  try {
    const user = c.get("user");
    if (
      user.role !== Role.LAB_TECHNICIAN &&
      user.role !== Role.DOCTOR &&
      user.role !== Role.CLINIC_ADMIN &&
      user.role !== Role.SUPER_ADMIN
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const params = searchParamsSchema.parse(c.req.query());
    const queryOptions = buildQueryOptions<Exam>(params);
    const { where, orderBy, ...restOptions } = queryOptions;

    const exams = await db.exam.findMany({
      where: {
        ...where,
        visit: {
          clinicId: user.role === Role.SUPER_ADMIN ? undefined : user.clinic.id,
          branchId: user.role === Role.SUPER_ADMIN ? undefined : user.branch.id,
        },
      } as Prisma.ExamWhereInput,
      orderBy: orderBy as Prisma.ExamOrderByWithRelationInput,
      ...restOptions,
      include: {
        visit: {
          select: {
            id: true,
            status: true,
            patient: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                phoneNumber: true,
              },
            },
          },
        },
        products: {
          select: {
            id: true,
            name: true,
            basePrice: true,
          },
        },
        results: {
          select: {
            id: true,
            examDate: true,
            results: true,
            notes: true,
            createdBy: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        tests: {
          select: {
            id: true,
            name: true,
            normalRange: true,
            unit: true,
          },
        },
        _count: {
          select: {
            results: true,
            tests: true,
          },
        },
      },
    });

    const totalCount = await db.exam.count({
      where: {
        ...where,
        visit: {
          clinicId: user.role === Role.SUPER_ADMIN ? undefined : user.clinic.id,
          branchId: user.role === Role.SUPER_ADMIN ? undefined : user.branch.id,
        },
      } as Prisma.ExamWhereInput,
    });

    const pageCount = restOptions.take
      ? Math.ceil(totalCount / restOptions.take)
      : 0;

    return c.json({
      status: httpCodes.OK,
      message: "Exams fetched successfully",
      data: exams,
      totalCount,
      pageCount,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const createExam = async (c: Context) => {
  try {
    const user = c.get("user");
    if (
      user.role !== Role.DOCTOR &&
      user.role !== Role.CLINIC_ADMIN &&
      user.role !== Role.SUPER_ADMIN
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const validatedFields = createExamSchema.safeParse(await c.req.json());
    if (!validatedFields.success) {
      return c.json({
        error: validatedFields.error.flatten().fieldErrors,
        status: httpCodes.BAD_REQUEST,
      });
    }

    const { visitId, name, description, productIds } = validatedFields.data;

    // Verify visit exists and belongs to user's clinic
    const visit = await db.visit.findUnique({
      where: { id: visitId },
      include: {
        patient: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (user.role !== Role.SUPER_ADMIN && visit.clinicId !== user.clinic.id) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    // Verify all products exist
    const products = await db.product.findMany({
      where: {
        id: { in: productIds },
        clinics: { some: { id: user.clinic.id } },
      },
    });

    if (products.length !== productIds.length) {
      return c.json(
        { error: "One or more products not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const exam = await db.exam.create({
      data: {
        visitId,
        name,
        description,
        products: {
          connect: productIds.map((id) => ({ id })),
        },
        status: ExamStatus.PENDING,
      },
      include: {
        visit: {
          select: {
            id: true,
            patient: {
              select: {
                firstName: true,
                lastName: true,
              },
            },
          },
        },
        products: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    // Invalidate visit-related caches
    await invalidateVisitRelatedCaches({
      clinicId: user.clinic.id,
      branchId: user.branch.id,
      visitId,
    });

    return c.json({
      status: httpCodes.CREATED,
      message: "Exam created successfully",
      data: exam,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getExamById = async (c: Context) => {
  try {
    const user = c.get("user");
    if (
      user.role !== Role.LAB_TECHNICIAN &&
      user.role !== Role.DOCTOR &&
      user.role !== Role.CLINIC_ADMIN &&
      user.role !== Role.SUPER_ADMIN
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const { id } = c.get("validatedParam");
    const examId = Number.parseInt(id, 10);

    const exam = await db.exam.findUnique({
      where: { id: examId },
      include: {
        visit: {
          select: {
            id: true,
            status: true,
            clinicId: true,
            patient: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                phoneNumber: true,
                dateOfBirth: true,
              },
            },
            doctor: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        products: {
          select: {
            id: true,
            name: true,
            basePrice: true,
            insurancePrices: true,
          },
        },
        results: {
          select: {
            id: true,
            examDate: true,
            results: true,
            notes: true,
            createdAt: true,
            createdBy: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: {
            createdAt: "desc",
          },
        },
        tests: {
          select: {
            id: true,
            name: true,
            description: true,
            normalRange: true,
            unit: true,
            consumables: true,
          },
        },
      },
    });

    if (!exam) {
      return c.json(
        { error: "Exam not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    // Check if user has access to this exam
    if (
      user.role !== Role.SUPER_ADMIN &&
      exam.visit.clinicId !== user.clinic.id
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    return c.json({
      status: httpCodes.OK,
      message: "Exam fetched successfully",
      data: exam,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updateExam = async (c: Context) => {
  try {
    const user = c.get("user");
    if (
      user.role !== Role.DOCTOR &&
      user.role !== Role.CLINIC_ADMIN &&
      user.role !== Role.SUPER_ADMIN
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const { id } = c.get("validatedParam");
    const examId = Number.parseInt(id, 10);

    const validatedFields = updateExamSchema.safeParse(await c.req.json());
    if (!validatedFields.success) {
      return c.json({
        error: validatedFields.error.flatten().fieldErrors,
        status: httpCodes.BAD_REQUEST,
      });
    }

    // Check if exam exists and user has access
    const existingExam = await db.exam.findUnique({
      where: { id: examId },
      include: {
        visit: {
          select: {
            clinicId: true,
          },
        },
      },
    });

    if (!existingExam) {
      return c.json(
        { error: "Exam not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (
      user.role !== Role.SUPER_ADMIN &&
      existingExam.visit.clinicId !== user.clinic.id
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const updatedExam = await db.exam.update({
      where: { id: examId },
      data: validatedFields.data,
      include: {
        visit: {
          select: {
            id: true,
            patient: {
              select: {
                firstName: true,
                lastName: true,
              },
            },
          },
        },
        products: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    // Invalidate visit-related caches
    await invalidateVisitRelatedCaches({
      clinicId: user.clinic.id,
      branchId: user.branch.id,
      visitId: updatedExam.visitId,
    });

    return c.json({
      status: httpCodes.OK,
      message: "Exam updated successfully",
      data: updatedExam,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

// Type for inventory consumables processing
type InventoryConsumablesData = {
  consumables: { name: string; quantity: string }[];
  visitId: number;
  userId: number;
  clinicId: number;
  branchId: number;
};

// Helper function to process inventory consumables
const processInventoryConsumables = async (data: InventoryConsumablesData) => {
  const { consumables, visitId, userId, clinicId, branchId } = data;
  for (const consumable of consumables) {
    const inventoryItem = await db.inventoryItem.findFirst({
      where: {
        itemName: {
          contains: consumable.name.trim(),
          mode: "insensitive",
        },
        clinicId,
      },
      include: {
        batches: true,
      },
    });

    if (!inventoryItem) {
      continue;
    }

    // Find oldest batch that hasn't expired
    const batch = inventoryItem.batches
      .filter((batchItem) => {
        const hasExpiryDate = Boolean(batchItem.expiryDate);
        const isNotExpired =
          hasExpiryDate &&
          batchItem.expiryDate &&
          batchItem.expiryDate > new Date();
        return isNotExpired;
      })
      .sort((a, b) => {
        const aHasExpiry = Boolean(a.expiryDate);
        const bHasExpiry = Boolean(b.expiryDate);
        if (!aHasExpiry) {
          return 0;
        }
        if (!bHasExpiry) {
          return 0;
        }
        const aTime = a.expiryDate?.getTime() ?? 0;
        const bTime = b.expiryDate?.getTime() ?? 0;
        return aTime - bTime;
      })[0];

    if (!batch) {
      continue;
    }

    const newStock = batch.currentQuantity - Number(consumable.quantity);
    if (newStock < 0) {
      throw new Error("Insufficient stock");
    }

    // Create a transaction that creates stock transaction and updates batch quantity
    await db.$transaction(async (tx) => {
      await tx.inventoryBatch.update({
        where: { id: batch.id },
        data: {
          currentQuantity: newStock,
          updatedAt: new Date(),
        },
      });

      await tx.transaction.create({
        data: {
          batchId: batch.id,
          quantity: -Number(consumable.quantity),
          type: TransactionType.CONSUMPTION,
          sourceType: SourceType.VISIT,
          visitId,
          userId,
          status: TransactionStatus.COMPLETED,
          itemId: inventoryItem.id,
        },
      });

      await tx.inventoryStock.update({
        where: { itemId: inventoryItem.id },
        data: { quantity: newStock },
      });
    });

    // Invalidate inventory cache
    await invalidateInventoryRelatedCaches({
      clinicId,
      branchId,
    });
  }
};

// Helper function to validate exam access
const validateExamAccess = async (
  examId: number,
  visitId: number,
  user: { role: Role; clinic: { id: number } }
) => {
  const exam = await db.exam.findUnique({
    where: { id: examId },
    include: {
      visit: {
        select: {
          clinicId: true,
          branchId: true,
        },
      },
    },
  });

  if (!exam) {
    throw new Error("Exam not found");
  }

  if (
    user.role !== Role.SUPER_ADMIN &&
    exam.visit.clinicId !== user.clinic.id
  ) {
    throw new Error("Forbidden");
  }

  if (exam.visitId !== visitId) {
    throw new Error("Exam does not belong to this visit");
  }

  return exam;
};

// Helper function to find product by name
const findProductByName = async (productName: string, clinicId: number) => {
  const product = await db.product.findFirst({
    where: {
      name: productName,
      clinics: {
        some: {
          id: clinicId,
        },
      },
    },
    include: {
      tests: true,
    },
  });

  if (!product) {
    throw new Error("Product not found");
  }

  return product;
};

// Type for exam result creation data
type ExamResultData = {
  user: { clinic: { id: number }; branch: { id: number }; id: string };
  visitId: number;
  examId: number;
  examDate?: string;
  results: unknown;
  notes?: string;
};

// Helper function to create exam result record
const createExamResultRecord = async (data: ExamResultData) => {
  const { user, visitId, examId, examDate, results, notes } = data;
  return await db.examResult.create({
    data: {
      clinicId: user.clinic.id,
      branchId: user.branch.id,
      visitId,
      examId,
      examDate: examDate ? new Date(examDate) : new Date(),
      results: results as Prisma.InputJsonValue,
      notes,
      createdById: Number(user.id),
    },
    include: {
      createdBy: {
        select: {
          id: true,
          name: true,
        },
      },
      visit: {
        select: {
          id: true,
          patient: {
            select: {
              firstName: true,
              lastName: true,
            },
          },
        },
      },
    },
  });
};

// Type for product consumables processing
type ProductConsumablesData = {
  product: { tests: { consumables: unknown }[] };
  visitId: number;
  userId: number;
  clinicId: number;
  branchId: number;
};

// Helper function to process product consumables
const processProductConsumables = async (data: ProductConsumablesData) => {
  const { product, visitId, userId, clinicId, branchId } = data;
  const productConsumables: { name: string; quantity: string }[] = product.tests
    .filter(
      (test: { consumables: unknown }) =>
        Array.isArray(test.consumables) && test.consumables.length > 0
    )
    .flatMap((test: { consumables: unknown }) => {
      return test.consumables as { name: string; quantity: string }[];
    });

  if (productConsumables.length > 0) {
    await processInventoryConsumables({
      consumables: productConsumables,
      visitId,
      userId,
      clinicId,
      branchId,
    });
  }
};

// Helper function to handle error responses
const handleExamResultError = (error: Error, c: Context) => {
  const errorMap: Record<string, [string, number]> = {
    "Exam not found": ["Exam not found", httpCodes.NOT_FOUND],
    Forbidden: ["Forbidden", httpCodes.FORBIDDEN],
    "Exam does not belong to this visit": [
      "Exam does not belong to this visit",
      httpCodes.BAD_REQUEST,
    ],
    "Product not found": ["Product not found", httpCodes.NOT_FOUND],
    "Insufficient stock": ["Insufficient stock", httpCodes.BAD_REQUEST],
  };

  const [message, status] = errorMap[error.message] || [
    "Internal Server Error",
    httpCodes.INTERNAL_SERVER_ERROR,
  ];

  return c.json({ error: message }, status as ContentfulStatusCode);
};

export const createExamResult = async (c: Context) => {
  try {
    const user = c.get("user");
    if (
      user.role !== Role.LAB_TECHNICIAN &&
      user.role !== Role.DOCTOR &&
      user.role !== Role.CLINIC_ADMIN &&
      user.role !== Role.SUPER_ADMIN
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const validatedFields = createExamResultSchema.safeParse(
      await c.req.json()
    );
    if (!validatedFields.success) {
      return c.json({
        error: validatedFields.error.flatten().fieldErrors,
        status: httpCodes.BAD_REQUEST,
      });
    }

    const { visitId, examId, examDate, results, notes } = validatedFields.data;

    // Validate exam access
    await validateExamAccess(examId, visitId, user);

    // Find product by name
    const product = await findProductByName(
      results.productName,
      user.clinic.id
    );

    // Create exam result
    const examResult = await createExamResultRecord({
      user,
      visitId,
      examId,
      examDate,
      results,
      notes,
    });

    // Process product consumables
    await processProductConsumables({
      product,
      visitId,
      userId: Number(user.id),
      clinicId: user.clinic.id,
      branchId: user.branch.id,
    });

    // Invalidate visit-related caches
    await invalidateVisitRelatedCaches({
      clinicId: user.clinic.id,
      branchId: user.branch.id,
      visitId,
    });

    return c.json({
      status: httpCodes.CREATED,
      message: "Exam result created successfully",
      data: examResult,
    });
  } catch (error) {
    if (error instanceof Error) {
      return handleExamResultError(error, c);
    }
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getExamResults = async (c: Context) => {
  try {
    const user = c.get("user");
    if (
      user.role !== Role.LAB_TECHNICIAN &&
      user.role !== Role.DOCTOR &&
      user.role !== Role.CLINIC_ADMIN &&
      user.role !== Role.SUPER_ADMIN
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const params = searchParamsSchema.parse(c.req.query());
    const queryOptions = buildQueryOptions<ExamResult>(params);
    const { where, orderBy, ...restOptions } = queryOptions;

    const results = await db.examResult.findMany({
      where: {
        ...where,
        clinicId: user.role === Role.SUPER_ADMIN ? undefined : user.clinic.id,
        branchId: user.role === Role.SUPER_ADMIN ? undefined : user.branch.id,
      } as Prisma.ExamResultWhereInput,
      orderBy: orderBy as Prisma.ExamResultOrderByWithRelationInput,
      ...restOptions,
      include: {
        exam: {
          select: {
            id: true,
            name: true,
            status: true,
          },
        },
        visit: {
          select: {
            id: true,
            patient: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                phoneNumber: true,
              },
            },
          },
        },
        createdBy: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    const totalCount = await db.examResult.count({
      where: {
        ...where,
        clinicId: user.role === Role.SUPER_ADMIN ? undefined : user.clinic.id,
        branchId: user.role === Role.SUPER_ADMIN ? undefined : user.branch.id,
      } as Prisma.ExamResultWhereInput,
    });

    const pageCount = restOptions.take
      ? Math.ceil(totalCount / restOptions.take)
      : 0;

    return c.json({
      status: httpCodes.OK,
      message: "Exam results fetched successfully",
      data: results,
      totalCount,
      pageCount,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getExamResultById = async (c: Context) => {
  try {
    const user = c.get("user");
    if (
      user.role !== Role.LAB_TECHNICIAN &&
      user.role !== Role.DOCTOR &&
      user.role !== Role.CLINIC_ADMIN &&
      user.role !== Role.SUPER_ADMIN
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const { id } = c.get("validatedParam");
    const resultId = Number.parseInt(id, 10);

    const result = await db.examResult.findUnique({
      where: { id: resultId },
      include: {
        exam: {
          select: {
            id: true,
            name: true,
            description: true,
            status: true,
            products: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        visit: {
          select: {
            id: true,
            status: true,
            patient: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                phoneNumber: true,
                dateOfBirth: true,
              },
            },
            doctor: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        createdBy: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!result) {
      return c.json(
        { error: "Exam result not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    // Check if user has access to this result
    if (user.role !== Role.SUPER_ADMIN && result.clinicId !== user.clinic.id) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    return c.json({
      status: httpCodes.OK,
      message: "Exam result fetched successfully",
      data: result,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updateExamResult = async (c: Context) => {
  try {
    const user = c.get("user");
    if (
      user.role !== Role.LAB_TECHNICIAN &&
      user.role !== Role.DOCTOR &&
      user.role !== Role.CLINIC_ADMIN &&
      user.role !== Role.SUPER_ADMIN
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const { id } = c.get("validatedParam");
    const resultId = Number.parseInt(id, 10);

    const validatedFields = updateExamResultSchema.safeParse(
      await c.req.json()
    );
    if (!validatedFields.success) {
      return c.json({
        error: validatedFields.error.flatten().fieldErrors,
        status: httpCodes.BAD_REQUEST,
      });
    }

    // Check if result exists and user has access
    const existingResult = await db.examResult.findUnique({
      where: { id: resultId },
      select: {
        clinicId: true,
        createdById: true,
      },
    });

    if (!existingResult) {
      return c.json(
        { error: "Exam result not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (
      user.role !== Role.SUPER_ADMIN &&
      existingResult.clinicId !== user.clinic.id
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const updatedResult = await db.examResult.update({
      where: { id: resultId },
      data: {
        ...validatedFields.data,
        results: validatedFields.data.results
          ? (validatedFields.data.results as Prisma.InputJsonValue)
          : undefined,
      },
      include: {
        exam: {
          select: {
            id: true,
            name: true,
          },
        },
        visit: {
          select: {
            id: true,
            patient: {
              select: {
                firstName: true,
                lastName: true,
              },
            },
          },
        },
        createdBy: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    // Invalidate visit-related caches
    await invalidateVisitRelatedCaches({
      clinicId: user.clinic.id,
      branchId: user.branch.id,
      visitId: updatedResult.visitId,
    });

    return c.json({
      status: httpCodes.OK,
      message: "Exam result updated successfully",
      data: updatedResult,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getExamTests = async (c: Context) => {
  try {
    const user = c.get("user");
    if (
      user.role !== Role.LAB_TECHNICIAN &&
      user.role !== Role.DOCTOR &&
      user.role !== Role.CLINIC_ADMIN &&
      user.role !== Role.SUPER_ADMIN
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const params = searchParamsSchema.parse(c.req.query());
    const queryOptions = buildQueryOptions<ExamTest>(params);
    const { where, orderBy, ...restOptions } = queryOptions;

    const tests = await db.examTest.findMany({
      where: {
        ...where,
        product: {
          clinics: {
            some: {
              id: user.role === Role.SUPER_ADMIN ? undefined : user.clinic.id,
            },
          },
        },
      } as Prisma.ExamTestWhereInput,
      orderBy: orderBy as Prisma.ExamTestOrderByWithRelationInput,
      ...restOptions,
      include: {
        product: {
          select: {
            id: true,
            name: true,
            basePrice: true,
          },
        },
        exam: {
          select: {
            id: true,
            name: true,
            status: true,
          },
        },
      },
    });

    const totalCount = await db.examTest.count({
      where: {
        ...where,
        product: {
          clinics: {
            some: {
              id: user.role === Role.SUPER_ADMIN ? undefined : user.clinic.id,
            },
          },
        },
      } as Prisma.ExamTestWhereInput,
    });

    const pageCount = restOptions.take
      ? Math.ceil(totalCount / restOptions.take)
      : 0;

    return c.json({
      status: httpCodes.OK,
      message: "Exam tests fetched successfully",
      data: tests,
      totalCount,
      pageCount,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const createExamTest = async (c: Context) => {
  try {
    const user = c.get("user");
    if (
      user.role !== Role.LAB_TECHNICIAN &&
      user.role !== Role.DOCTOR &&
      user.role !== Role.CLINIC_ADMIN &&
      user.role !== Role.SUPER_ADMIN
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const validatedFields = createExamTestSchema.safeParse(await c.req.json());
    if (!validatedFields.success) {
      return c.json({
        error: validatedFields.error.flatten().fieldErrors,
        status: httpCodes.BAD_REQUEST,
      });
    }

    const {
      name,
      description,
      normalRange,
      unit,
      productId,
      examId,
      consumables,
    } = validatedFields.data;

    // Verify product exists and belongs to user's clinic
    const product = await db.product.findUnique({
      where: { id: productId },
      select: {
        clinics: {
          select: { id: true },
        },
      },
    });

    if (!product) {
      return c.json(
        { error: "Product not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (
      user.role !== Role.SUPER_ADMIN &&
      !product.clinics.some((clinic) => clinic.id === user.clinic.id)
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    // Verify exam exists if provided
    if (examId) {
      const exam = await db.exam.findUnique({
        where: { id: examId },
        include: {
          visit: {
            select: { clinicId: true },
          },
        },
      });

      if (!exam) {
        return c.json(
          { error: "Exam not found" },
          httpCodes.NOT_FOUND as ContentfulStatusCode
        );
      }

      if (
        user.role !== Role.SUPER_ADMIN &&
        exam.visit.clinicId !== user.clinic.id
      ) {
        return c.json(
          { error: "Forbidden" },
          httpCodes.FORBIDDEN as ContentfulStatusCode
        );
      }
    }

    const test = await db.examTest.create({
      data: {
        name,
        description,
        normalRange,
        unit,
        productId,
        examId,
        consumables: consumables
          ? (consumables as Prisma.InputJsonValue)
          : undefined,
      },
      include: {
        product: {
          select: {
            id: true,
            name: true,
          },
        },
        exam: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return c.json({
      status: httpCodes.CREATED,
      message: "Exam test created successfully",
      data: test,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updateExamTest = async (c: Context) => {
  try {
    const user = c.get("user");
    if (
      user.role !== Role.LAB_TECHNICIAN &&
      user.role !== Role.DOCTOR &&
      user.role !== Role.CLINIC_ADMIN &&
      user.role !== Role.SUPER_ADMIN
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const { id } = c.get("validatedParam");
    const testId = Number.parseInt(id, 10);

    const validatedFields = updateExamTestSchema.safeParse(await c.req.json());
    if (!validatedFields.success) {
      return c.json({
        error: validatedFields.error.flatten().fieldErrors,
        status: httpCodes.BAD_REQUEST,
      });
    }

    // Check if test exists and user has access
    const existingTest = await db.examTest.findUnique({
      where: { id: testId },
      include: {
        product: {
          select: {
            clinics: {
              select: { id: true },
            },
          },
        },
      },
    });

    if (!existingTest) {
      return c.json(
        { error: "Exam test not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (
      user.role !== Role.SUPER_ADMIN &&
      !existingTest.product.clinics.some(
        (clinic) => clinic.id === user.clinic.id
      )
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const updatedTest = await db.examTest.update({
      where: { id: testId },
      data: {
        ...validatedFields.data,
        consumables: validatedFields.data.consumables
          ? (validatedFields.data.consumables as Prisma.InputJsonValue)
          : undefined,
      },
      include: {
        product: {
          select: {
            id: true,
            name: true,
          },
        },
        exam: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return c.json({
      status: httpCodes.OK,
      message: "Exam test updated successfully",
      data: updatedTest,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updateExamTestUnits = async (c: Context) => {
  try {
    const user = c.get("user");
    if (
      user.role !== Role.LAB_TECHNICIAN &&
      user.role !== Role.DOCTOR &&
      user.role !== Role.CLINIC_ADMIN &&
      user.role !== Role.SUPER_ADMIN
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const { id } = c.get("validatedParam");
    const testId = Number.parseInt(id, 10);

    const validatedFields = updateExamTestUnitsSchema.safeParse(
      await c.req.json()
    );
    if (!validatedFields.success) {
      return c.json({
        error: validatedFields.error.flatten().fieldErrors,
        status: httpCodes.BAD_REQUEST,
      });
    }

    const { unit } = validatedFields.data;

    // Check if test exists and user has access
    const existingTest = await db.examTest.findUnique({
      where: { id: testId },
      include: {
        product: {
          select: {
            clinics: {
              select: { id: true },
            },
          },
        },
      },
    });

    if (!existingTest) {
      return c.json(
        { error: "Exam test not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (
      user.role !== Role.SUPER_ADMIN &&
      !existingTest.product.clinics.some(
        (clinic) => clinic.id === user.clinic.id
      )
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    await db.examTest.update({
      where: { id: testId },
      data: { unit },
    });

    return c.json({
      status: httpCodes.OK,
      message: "Exam test units updated successfully",
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updateExamTestNormalRange = async (c: Context) => {
  try {
    const user = c.get("user");
    if (
      user.role !== Role.LAB_TECHNICIAN &&
      user.role !== Role.DOCTOR &&
      user.role !== Role.CLINIC_ADMIN &&
      user.role !== Role.SUPER_ADMIN
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const { id } = c.get("validatedParam");
    const testId = Number.parseInt(id, 10);

    const validatedFields = updateExamTestNormalRangeSchema.safeParse(
      await c.req.json()
    );
    if (!validatedFields.success) {
      return c.json({
        error: validatedFields.error.flatten().fieldErrors,
        status: httpCodes.BAD_REQUEST,
      });
    }

    const { normalRange } = validatedFields.data;

    // Check if test exists and user has access
    const existingTest = await db.examTest.findUnique({
      where: { id: testId },
      include: {
        product: {
          select: {
            clinics: {
              select: { id: true },
            },
          },
        },
      },
    });

    if (!existingTest) {
      return c.json(
        { error: "Exam test not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (
      user.role !== Role.SUPER_ADMIN &&
      !existingTest.product.clinics.some(
        (clinic) => clinic.id === user.clinic.id
      )
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    await db.examTest.update({
      where: { id: testId },
      data: { normalRange },
    });

    return c.json({
      status: httpCodes.OK,
      message: "Exam test normal range updated successfully",
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updateExamTestConsumables = async (c: Context) => {
  try {
    const user = c.get("user");
    if (
      user.role !== Role.LAB_TECHNICIAN &&
      user.role !== Role.DOCTOR &&
      user.role !== Role.CLINIC_ADMIN &&
      user.role !== Role.SUPER_ADMIN
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const { id } = c.get("validatedParam");
    const testId = Number.parseInt(id, 10);

    const validatedFields = updateExamTestConsumablesSchema.safeParse(
      await c.req.json()
    );
    if (!validatedFields.success) {
      return c.json({
        error: validatedFields.error.flatten().fieldErrors,
        status: httpCodes.BAD_REQUEST,
      });
    }

    const { consumables } = validatedFields.data;

    // Check if test exists and user has access
    const existingTest = await db.examTest.findUnique({
      where: { id: testId },
      include: {
        product: {
          select: {
            clinics: {
              select: { id: true },
            },
          },
        },
      },
    });

    if (!existingTest) {
      return c.json(
        { error: "Exam test not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (
      user.role !== Role.SUPER_ADMIN &&
      !existingTest.product.clinics.some(
        (clinic) => clinic.id === user.clinic.id
      )
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const consumablesData =
      consumables === null
        ? Prisma.JsonNull
        : (consumables as Prisma.InputJsonValue);

    await db.examTest.update({
      where: { id: testId },
      data: { consumables: consumablesData },
    });

    return c.json({
      status: httpCodes.OK,
      message: "Exam test consumables updated successfully",
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getExamsByVisitId = async (c: Context) => {
  try {
    const user = c.get("user");
    if (
      user.role !== Role.LAB_TECHNICIAN &&
      user.role !== Role.DOCTOR &&
      user.role !== Role.CLINIC_ADMIN &&
      user.role !== Role.SUPER_ADMIN
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const { visitId } = c.get("validatedParam");
    const visitIdNumber = Number.parseInt(visitId, 10);

    // Verify visit exists and user has access
    const visit = await db.visit.findUnique({
      where: { id: visitIdNumber },
      select: {
        clinicId: true,
        branchId: true,
        patient: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (user.role !== Role.SUPER_ADMIN && visit.clinicId !== user.clinic.id) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const exams = await db.exam.findMany({
      where: { visitId: visitIdNumber },
      include: {
        products: {
          select: {
            id: true,
            name: true,
            basePrice: true,
          },
        },
        results: {
          select: {
            id: true,
            examDate: true,
            results: true,
            notes: true,
            createdBy: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: {
            createdAt: "desc",
          },
        },
        tests: {
          select: {
            id: true,
            name: true,
            normalRange: true,
            unit: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return c.json({
      status: httpCodes.OK,
      message: "Visit exams fetched successfully",
      data: exams,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
