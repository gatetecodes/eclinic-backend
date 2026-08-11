import { isValid, parseISO } from "date-fns";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  type Exam,
  type ExamResult,
  ExamStatus,
  type ExamTest,
  PaymentStatus,
  PaymentType,
  Prisma,
  Role,
  SourceType,
  TransactionStatus,
  TransactionType,
  VisitStatus,
} from "../../../../generated/prisma/client";
import { db } from "../../../database/db";
import { refreshItemStatus } from "../../../helpers/inventory-helpers";
import { buildQueryOptions } from "../../../helpers/query-helper";
import {
  invalidateInventoryRelatedCaches,
  invalidateVisitRelatedCaches,
} from "../../../lib/cache-utils";
import { searchParamsSchema } from "../../../lib/common-validation";
import { httpCodes } from "../../../lib/constants";
import { getScope } from "../../../lib/request-scope";
import { enqueueCurrentClinicalEventsInTransaction } from "../../../services/hie/outbox.service";
import {
  createExamSchema,
  createExamTestSchema,
  updateExamResultSchema,
  updateExamSchema,
  updateExamTestConsumablesSchema,
  updateExamTestNormalRangeSchema,
  updateExamTestSchema,
  updateExamTestUnitsSchema,
} from "./exams.validation";

const UNSETTLED_EXAM_PAYMENT_STATUSES = [
  PaymentStatus.PENDING,
  PaymentStatus.PARTIALLY_PAID,
] as const;

const EXAM_TEST_MANAGER_ROLES = new Set<Role>([
  Role.LAB_TECHNICIAN,
  Role.DOCTOR,
  Role.CLINIC_ADMIN,
  Role.SUPER_ADMIN,
]);

const getUserClinicId = (user: {
  clinicId?: number | null;
  clinic?: { id?: number | null } | null;
}) => user.clinicId ?? user.clinic?.id;

const canManageExamTests = (role: Role) => EXAM_TEST_MANAGER_ROLES.has(role);

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
    const { clinicId, branchId } = getScope(user, params);
    const queryOptions = buildQueryOptions<Exam>(params);
    const { where, orderBy, ...restOptions } = queryOptions;

    const scopedWhere: Prisma.ExamWhereInput = {
      ...(where as Prisma.ExamWhereInput),
      visit: {
        ...(((where as Prisma.ExamWhereInput).visit ??
          {}) as Prisma.VisitWhereInput),
        ...(typeof clinicId === "number" ? { clinicId } : {}),
        ...(typeof branchId === "number" ? { branchId } : {}),
        ...(user.role === Role.LAB_TECHNICIAN
          ? {
              status: VisitStatus.PENDING_TESTS,
              payments: {
                some: { paymentType: PaymentType.ADDITIONAL_EXAM },
                none: {
                  paymentType: PaymentType.ADDITIONAL_EXAM,
                  paymentStatus: { in: [...UNSETTLED_EXAM_PAYMENT_STATUSES] },
                  patientAmount: { gt: 0 },
                },
              },
            }
          : {}),
      },
    };

    const exams = await db.exam.findMany({
      where: scopedWhere,
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
            // Configured sub-parameters of the lab product, used to seed the
            // result-entry form's parameter rows.
            tests: {
              select: {
                id: true,
                name: true,
                unit: true,
                normalRange: true,
              },
            },
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
      where: scopedWhere,
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

    if (user.role !== Role.SUPER_ADMIN && visit.clinicId !== user.clinicId) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    // Verify all products exist
    const products = await db.product.findMany({
      where: {
        id: { in: productIds },
        ...(user.role === Role.SUPER_ADMIN
          ? {}
          : { clinics: { some: { id: user.clinicId } } }),
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
        clinic: { connect: { id: user.clinicId } },
        visit: { connect: { id: visitId } },
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
      clinicId: user.clinicId,
      branchId: user.branchId,
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
      exam.visit.clinicId !== user.clinicId
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
      existingExam.visit.clinicId !== user.clinicId
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
      clinicId: user.clinicId,
      branchId: user.branchId,
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

      await refreshItemStatus(tx, inventoryItem.id);
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
  user: { role: Role; clinicId: number }
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

  if (user.role !== Role.SUPER_ADMIN && exam.visit.clinicId !== user.clinicId) {
    throw new Error("Forbidden");
  }

  if (exam.visitId !== visitId) {
    throw new Error("Exam does not belong to this visit");
  }

  return exam;
};

const assertExamChargesSettled = async (visitId: number) => {
  const unpaidExamBills = await db.payment.count({
    where: {
      visitId,
      paymentType: PaymentType.ADDITIONAL_EXAM,
      paymentStatus: { in: [...UNSETTLED_EXAM_PAYMENT_STATUSES] },
      patientAmount: { gt: 0 },
    },
  });

  if (unpaidExamBills > 0) {
    throw new Error("Exam charges must be paid before results can be entered");
  }
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
  user: { clinicId: number; branchId: number; id: string };
  visitId: number;
  examId: number;
  examDate?: string;
  results: unknown;
  notes?: string;
  productId: number;
};

type ExamResultsPayload = {
  productName: string;
  parameters?: {
    name?: string;
    value?: string;
    unit?: string;
    referenceRange?: string;
  }[];
  conclusion?: string;
  notes?: string;
};

// Helper function to create exam result record
const createExamResultRecord = async (
  tx: Prisma.TransactionClient,
  data: ExamResultData
) => {
  const { user, visitId, examId, examDate, results, notes, productId } = data;
  return await tx.examResult.create({
    data: {
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
      examId,
      productId,
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
    "Exam charges must be paid before results can be entered": [
      "Exam charges must be paid before results can be entered",
      httpCodes.BAD_REQUEST,
    ],
    "Insufficient stock": ["Insufficient stock", httpCodes.BAD_REQUEST],
  };

  const [message, status] = errorMap[error.message] || [
    "Internal Server Error",
    httpCodes.INTERNAL_SERVER_ERROR,
  ];

  return c.json({ error: message }, status as ContentfulStatusCode);
};

//biome-ignore lint/complexity/noExcessiveCognitiveComplexity:<>
export const getExamConsumption = async (c: Context) => {
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
    const { clinicId, branchId } = getScope(user, params);
    const { from, to } = params;

    const dateFilter: Prisma.ExamResultWhereInput = {};
    if (from || to) {
      const fromDate = from ? parseISO(from) : null;
      const toDate = to ? parseISO(to) : null;

      if ((fromDate && isValid(fromDate)) || (toDate && isValid(toDate))) {
        dateFilter.examDate = {
          ...(fromDate && isValid(fromDate) ? { gte: fromDate } : {}),
          ...(toDate && isValid(toDate) ? { lte: toDate } : {}),
        };
      }
    }

    const [exams, totalVisits] = await Promise.all([
      db.examResult.groupBy({
        by: ["results"],
        where: {
          ...(typeof clinicId === "number" ? { clinicId } : {}),
          ...(typeof branchId === "number" ? { branchId } : {}),
          ...dateFilter,
        },
        _count: {
          id: true,
        },
      }),
      db.examResult.groupBy({
        by: ["visitId"],
        where: {
          ...(typeof clinicId === "number" ? { clinicId } : {}),
          ...(typeof branchId === "number" ? { branchId } : {}),
          ...dateFilter,
        },
      }),
    ]);

    const totalVisitCount = totalVisits.length;

    const consumption = exams.map((exam) => {
      const results = exam.results as unknown as ExamResultsPayload;
      return {
        examName: results?.productName || "Unknown",
        visitCount: exam._count.id,
      };
    });

    const aggregated = consumption.reduce(
      (acc, curr) => {
        const existing = acc.find((a) => a.examName === curr.examName);
        if (existing) {
          existing.visitCount += curr.visitCount;
        } else {
          acc.push(curr);
        }
        return acc;
      },
      [] as { examName: string; visitCount: number }[]
    );

    return c.json({
      status: httpCodes.OK,
      message: "Exam consumption fetched successfully",
      data: aggregated,
      totalCount: aggregated.length,
      totalVisits: totalVisitCount,
      pageCount: 1,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

//biome-ignore lint/complexity/noExcessiveCognitiveComplexity:<>
export const getExamConsumptionDetails = async (c: Context) => {
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

    const { examName } = c.req.param();
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId, branchId } = getScope(user, params);
    const { from, to } = params;

    const dateFilter: Prisma.ExamResultWhereInput = {};
    if (from || to) {
      const fromDate = from ? parseISO(from) : null;
      const toDate = to ? parseISO(to) : null;

      if ((fromDate && isValid(fromDate)) || (toDate && isValid(toDate))) {
        dateFilter.examDate = {
          ...(fromDate && isValid(fromDate) ? { gte: fromDate } : {}),
          ...(toDate && isValid(toDate) ? { lte: toDate } : {}),
        };
      }
    }

    const results = await db.examResult.findMany({
      where: {
        ...(typeof clinicId === "number" ? { clinicId } : {}),
        ...(typeof branchId === "number" ? { branchId } : {}),
        results: {
          path: ["productName"],
          equals: examName,
        },
        ...dateFilter,
      } as Prisma.ExamResultWhereInput,
      include: {
        visit: {
          include: {
            patient: true,
            doctor: true,
          },
        },
      },
      orderBy: {
        examDate: "desc",
      },
    });

    return c.json({
      status: httpCodes.OK,
      message: "Exam consumption details fetched successfully",
      data: results,
      totalCount: results.length,
      pageCount: 1,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

// Removed legacy NormalizedCreateExamPayload; we accept frontend-only flattened payload now

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

    const {
      visitId,
      examId,
      examDate,
      productName,
      parameters,
      conclusion,
      notes,
    } = c.get("validatedJson") as {
      visitId: number;
      examId: number;
      examDate?: string;
      productName: string;
      parameters?: {
        name?: string;
        value?: string;
        unit?: string;
        referenceRange?: string;
      }[];
      conclusion?: string;
      notes?: string;
    };
    const results = { productName, parameters, conclusion, notes };

    // Validate exam access
    await validateExamAccess(examId, visitId, user);
    await assertExamChargesSettled(visitId);

    // Find product by name
    const product = await findProductByName(productName, user.clinicId);

    // Create exam result
    const examResult = await db.$transaction(async (tx) => {
      const created = await createExamResultRecord(tx, {
        user,
        visitId,
        examId,
        examDate,
        results,
        notes,
        productId: product.id,
      });
      const visit = await tx.visit.findUniqueOrThrow({
        where: { id: visitId },
        select: { patientId: true },
      });
      await enqueueCurrentClinicalEventsInTransaction(tx, {
        clinicId: user.clinicId,
        visitId,
        patientId: visit.patientId,
      });
      return created;
    });

    // Process product consumables
    await processProductConsumables({
      product,
      visitId,
      userId: Number(user.id),
      clinicId: user.clinicId,
      branchId: user.branchId,
    });

    // Invalidate visit-related caches
    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
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
    const { clinicId, branchId } = getScope(user, params);
    const queryOptions = buildQueryOptions<ExamResult>(params);
    const { where, orderBy, ...restOptions } = queryOptions;

    const results = await db.examResult.findMany({
      where: {
        ...where,
        ...(typeof clinicId === "number" ? { clinicId } : {}),
        ...(typeof branchId === "number" ? { branchId } : {}),
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
        ...(typeof clinicId === "number" ? { clinicId } : {}),
        ...(typeof branchId === "number" ? { branchId } : {}),
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
    if (user.role !== Role.SUPER_ADMIN && result.clinicId !== user.clinicId) {
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

//biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
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
      existingResult.clinicId !== user.clinicId
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    if (user.role === Role.LAB_TECHNICIAN) {
      const existingResultVisit = await db.examResult.findUnique({
        where: { id: resultId },
        select: { visitId: true },
      });

      if (!existingResultVisit) {
        return c.json(
          { error: "Exam result not found" },
          httpCodes.NOT_FOUND as ContentfulStatusCode
        );
      }

      try {
        await assertExamChargesSettled(existingResultVisit.visitId);
      } catch (error) {
        return handleExamResultError(error as Error, c);
      }
    }

    const flatUpdate = validatedFields.data as Record<string, unknown>;
    const hasNestedResults = "results" in flatUpdate;
    const hasFlattenedResultsFields =
      "productName" in flatUpdate ||
      "parameters" in flatUpdate ||
      "conclusion" in flatUpdate;

    let normalizedResults: Prisma.InputJsonValue | undefined;
    if (hasNestedResults) {
      normalizedResults = flatUpdate.results as Prisma.InputJsonValue;
    } else if (
      hasFlattenedResultsFields &&
      typeof flatUpdate.productName === "string"
    ) {
      normalizedResults = {
        productName: flatUpdate.productName as string,
        parameters: flatUpdate.parameters as
          | {
              name?: string;
              value?: string;
              unit?: string;
              referenceRange?: string;
            }[]
          | undefined,
        conclusion: flatUpdate.conclusion as string | undefined,
      } as Prisma.InputJsonValue;
    } else {
      normalizedResults = undefined;
    }

    const updatedResult = await db.examResult.update({
      where: { id: resultId },
      data: {
        // notes may be present in either union branch
        notes: (flatUpdate.notes as string | undefined) ?? undefined,
        // results only when provided
        results: normalizedResults,
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
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId: updatedResult.visitId,
    });

    return c.json(
      {
        status: httpCodes.OK,
        message: "Exam result updated successfully",
        data: updatedResult,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

/** Fold a Prisma groupBy(testType) result into segmented-tab counts. */
const tallyExamTestCounts = (
  grouped: { testType: string; _count: { _all: number } }[]
) => {
  const counts = { all: 0, numeric: 0, qualitative: 0 };
  for (const group of grouped) {
    counts.all += group._count._all;
    if (group.testType === "NUMERIC") {
      counts.numeric = group._count._all;
    } else if (group.testType === "QUALITATIVE") {
      counts.qualitative = group._count._all;
    }
  }
  return counts;
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
    if (
      params.type &&
      params.type !== "NUMERIC" &&
      params.type !== "QUALITATIVE"
    ) {
      return c.json(
        { error: "Invalid exam test type" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const { clinicId } = getScope(user, params);
    // ExamTest has no clinicId/branchId columns — scope is applied via the
    // parent product's clinics below, so keep the base `where` free of them
    // (injecting them here made Prisma throw "Unknown argument clinicId").
    const queryOptions = buildQueryOptions<ExamTest>(params);
    const { where, orderBy, ...restOptions } = queryOptions;

    let scopedClinicId: number | undefined;
    if (typeof clinicId === "number") {
      scopedClinicId = clinicId;
    } else if (user.role !== Role.SUPER_ADMIN) {
      scopedClinicId = getUserClinicId(user);
      if (typeof scopedClinicId !== "number") {
        return c.json(
          { error: "Forbidden" },
          httpCodes.FORBIDDEN as ContentfulStatusCode
        );
      }
    }

    // Base filter: product-clinic scope + name search (from buildQueryOptions).
    // The `type` tab filter is applied only to the listing, NOT to the counts,
    // so the segmented tabs always show the full breakdown for the search.
    const baseWhere: Prisma.ExamTestWhereInput = {
      ...(where as Prisma.ExamTestWhereInput),
      ...(typeof scopedClinicId === "number"
        ? { product: { clinics: { some: { id: scopedClinicId } } } }
        : {}),
    };

    const testTypeFilter = params.type as "NUMERIC" | "QUALITATIVE" | undefined;
    const listWhere: Prisma.ExamTestWhereInput = testTypeFilter
      ? { ...baseWhere, testType: testTypeFilter }
      : baseWhere;

    const [tests, totalCount, grouped] = await Promise.all([
      db.examTest.findMany({
        where: listWhere,
        orderBy: orderBy as Prisma.ExamTestOrderByWithRelationInput,
        ...restOptions,
        include: {
          product: { select: { id: true, name: true, basePrice: true } },
          exam: { select: { id: true, name: true, status: true } },
        },
      }),
      db.examTest.count({ where: listWhere }),
      db.examTest.groupBy({
        by: ["testType"],
        where: baseWhere,
        _count: { _all: true },
      }),
    ]);

    const counts = tallyExamTestCounts(grouped);

    const pageCount = restOptions.take
      ? Math.ceil(totalCount / restOptions.take)
      : 0;

    return c.json({
      status: httpCodes.OK,
      message: "Exam tests fetched successfully",
      data: tests,
      totalCount,
      pageCount,
      counts,
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
    if (!canManageExamTests(user.role)) {
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
      specimen,
      testType,
      referenceLow,
      referenceHigh,
      criticalLow,
      criticalHigh,
      qualitativeExpected,
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

    const userClinicId = getUserClinicId(user);

    if (
      user.role !== Role.SUPER_ADMIN &&
      !(
        userClinicId &&
        product.clinics.some((clinic) => clinic.id === userClinicId)
      )
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
        (!userClinicId || exam.visit.clinicId !== userClinicId)
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
        specimen,
        testType,
        referenceLow,
        referenceHigh,
        criticalLow,
        criticalHigh,
        qualitativeExpected,
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

    const userClinicId = getUserClinicId(user);

    if (
      user.role !== Role.SUPER_ADMIN &&
      !(
        userClinicId &&
        existingTest.product.clinics.some(
          (clinic) => clinic.id === userClinicId
        )
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

/**
 * Batch-save handler for the Tests Management screen. Updates the structured
 * result-flagging config (unit, specimen, type, reference & critical bounds,
 * qualitative expected value) for many tests in a single transaction. Absent
 * fields are left untouched; explicit null clears a value.
 */
export const bulkUpdateExamTests = async (c: Context) => {
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

    const { tests } = c.get("validatedJson") as {
      tests: Array<{
        id: number;
        unit?: string | null;
        specimen?: string | null;
        testType?: "NUMERIC" | "QUALITATIVE";
        referenceLow?: number | null;
        referenceHigh?: number | null;
        criticalLow?: number | null;
        criticalHigh?: number | null;
        qualitativeExpected?: string | null;
      }>;
    };
    const userClinicId = getUserClinicId(user);
    const ids = tests.map((t) => t.id);

    // Load the targeted tests once and verify clinic ownership before writing.
    const existing = await db.examTest.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        product: { select: { clinics: { select: { id: true } } } },
      },
    });
    const existingById = new Map(existing.map((t) => [t.id, t]));

    for (const id of ids) {
      const found = existingById.get(id);
      if (!found) {
        return c.json(
          { error: `Exam test ${id} not found` },
          httpCodes.NOT_FOUND as ContentfulStatusCode
        );
      }
      if (
        user.role !== Role.SUPER_ADMIN &&
        !(
          userClinicId &&
          found.product.clinics.some((clinic) => clinic.id === userClinicId)
        )
      ) {
        return c.json(
          { error: "Forbidden" },
          httpCodes.FORBIDDEN as ContentfulStatusCode
        );
      }
    }

    const updated = await db.$transaction(
      tests.map((t) =>
        db.examTest.update({
          where: { id: t.id },
          data: {
            unit: t.unit,
            specimen: t.specimen,
            testType: t.testType,
            referenceLow: t.referenceLow,
            referenceHigh: t.referenceHigh,
            criticalLow: t.criticalLow,
            criticalHigh: t.criticalHigh,
            qualitativeExpected: t.qualitativeExpected,
          },
          include: {
            product: { select: { id: true, name: true } },
            exam: { select: { id: true, name: true } },
          },
        })
      )
    );

    return c.json({
      status: httpCodes.OK,
      success: true,
      message: `${updated.length} test${updated.length === 1 ? "" : "s"} updated successfully`,
      data: updated,
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

    const userClinicId = getUserClinicId(user);

    if (
      user.role !== Role.SUPER_ADMIN &&
      !(
        userClinicId &&
        existingTest.product.clinics.some(
          (clinic) => clinic.id === userClinicId
        )
      )
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const updatedTest = await db.examTest.update({
      where: { id: testId },
      data: { unit },
    });

    return c.json(
      {
        status: httpCodes.OK,
        success: true,
        message: "Exam test units updated successfully",
        data: updatedTest,
      },
      httpCodes.OK as ContentfulStatusCode
    );
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

    const userClinicId = getUserClinicId(user);

    if (
      user.role !== Role.SUPER_ADMIN &&
      !(
        userClinicId &&
        existingTest.product.clinics.some(
          (clinic) => clinic.id === userClinicId
        )
      )
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const updatedTest = await db.examTest.update({
      where: { id: testId },
      data: { normalRange },
    });

    return c.json(
      {
        status: httpCodes.OK,
        success: true,
        message: "Exam test normal range updated successfully",
        data: updatedTest,
      },
      httpCodes.OK as ContentfulStatusCode
    );
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

    const userClinicId = getUserClinicId(user);

    if (
      user.role !== Role.SUPER_ADMIN &&
      !(
        userClinicId &&
        existingTest.product.clinics.some(
          (clinic) => clinic.id === userClinicId
        )
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

    const updatedTest = await db.examTest.update({
      where: { id: testId },
      data: { consumables: consumablesData },
    });

    return c.json(
      {
        status: httpCodes.OK,
        success: true,
        message: "Exam test consumables updated successfully",
        data: updatedTest,
      },
      httpCodes.OK as ContentfulStatusCode
    );
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

    const userClinicId = getUserClinicId(user);

    if (
      user.role !== Role.SUPER_ADMIN &&
      (!userClinicId || visit.clinicId !== userClinicId)
    ) {
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
            // Configured sub-parameters of the lab product, used to seed the
            // result-entry form's parameter rows.
            tests: {
              select: {
                id: true,
                name: true,
                unit: true,
                normalRange: true,
              },
            },
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
