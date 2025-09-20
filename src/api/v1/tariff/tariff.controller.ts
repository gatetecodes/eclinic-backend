import { parse } from "csv-parse/sync";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  PriceType,
  type Prisma,
  type Product,
  type ProductCategory,
  Role,
} from "../../../../generated/prisma";
import { db } from "../../../database/db";
import { buildQueryOptions } from "../../../helpers/query-helper";
import {
  createNewInsurancePrice,
  createNewProduct,
  findExistingProduct,
  handleExistingProduct,
  type ProductCSVRow,
} from "../../../helpers/tariff-helpers";
import { searchParamsSchema } from "../../../lib/common-validation";
import {
  httpCodes,
  InsuranceCompanies,
  SpecialInsurers,
} from "../../../lib/constants";
import { logger } from "../../../lib/logger";
import {
  createProductSchema,
  importProductsSchema,
  updateProductPricingSchema,
  updateProductSchema,
} from "./tariff.validation";

// Small helpers to keep handlers simple (reduce complexity)
function userHasTariffWriteAccess(user: { role: Role }) {
  return user.role === Role.CLINIC_ADMIN || user.role === Role.SUPER_ADMIN;
}

async function departmentsExistByIds(departmentIds: number[]) {
  const count = await db.department.count({
    where: { id: { in: departmentIds } },
  });
  return count === departmentIds.length;
}

async function isProductCodeConflicting(
  newCode: string | undefined,
  currentCode: string
) {
  if (!newCode || newCode === currentCode) {
    return false;
  }
  const found = await db.product.findUnique({ where: { code: newCode } });
  return Boolean(found);
}

function userCanAccessProduct(
  user: { role: Role; clinic: { id: number } },
  product: { clinics: { id: number }[] }
) {
  if (user.role === Role.SUPER_ADMIN) {
    return true;
  }
  return product.clinics.some((clinic) => clinic.id === user.clinic.id);
}

async function createInitialInsurancePricesForNewProduct(
  productId: number,
  tariffs: { tariff: number; tariffWithCo: number; govTariff: number }
) {
  const { tariff, tariffWithCo, govTariff } = tariffs;
  if (!Number.isNaN(tariff)) {
    for (const insuranceCompanyName of Object.values(InsuranceCompanies)) {
      await createNewInsurancePrice({
        productId,
        price: tariff,
        insuranceCompanyName,
        priceType: PriceType.PRIVATE,
      });
    }
  }
  if (!Number.isNaN(tariffWithCo)) {
    for (const insuranceCompanyName of Object.values(InsuranceCompanies)) {
      await createNewInsurancePrice({
        productId,
        price: tariffWithCo,
        insuranceCompanyName,
        priceType: PriceType.PRIVATE,
      });
    }
  }
  if (!Number.isNaN(govTariff)) {
    for (const insuranceCompanyName of Object.values(SpecialInsurers)) {
      await createNewInsurancePrice({
        productId,
        price: govTariff,
        insuranceCompanyName,
        priceType: PriceType.GOV,
      });
    }
  }
}

export const getTariff = async (c: Context) => {
  try {
    const user = c.get("user");
    if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const params = searchParamsSchema.parse(c.req.query());
    const queryOptions = buildQueryOptions<Product>(params);
    const { where, orderBy, ...restOptions } = queryOptions;

    const products = await db.product.findMany({
      ...restOptions,
      where: {
        ...where,
        clinics: {
          some: {
            id: user.role === Role.SUPER_ADMIN ? undefined : user.clinic.id,
          },
        },
      } as Prisma.ProductWhereInput,
      orderBy: orderBy as Prisma.ProductOrderByWithRelationInput,
      select: {
        id: true,
        name: true,
        code: true,
        category: true,
        basePrice: true,
        foreignersPrice: true,
        unit: true,
        normalRange: true,
        isActive: true,
        departments: {
          select: {
            id: true,
            name: true,
          },
        },
        clinics: {
          select: {
            id: true,
            name: true,
          },
        },
        insurancePrices: {
          select: {
            id: true,
            price: true,
            priceWithCo: true,
            priceType: true,
            insuranceCompany: {
              select: {
                id: true,
                companyName: true,
              },
            },
          },
        },
        updatedAt: true,
        createdAt: true,
      },
    });

    const totalCount = await db.product.count({
      where: {
        ...where,
        clinics: {
          some: {
            id: user.role === Role.SUPER_ADMIN ? undefined : user.clinic.id,
          },
        },
      } as Prisma.ProductWhereInput,
    });

    const pageCount = restOptions.take
      ? Math.ceil(totalCount / restOptions.take)
      : 0;

    return c.json({
      status: httpCodes.OK,
      message: "Tariff fetched successfully",
      data: products,
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

export const getProductsList = async (c: Context) => {
  try {
    const user = c.get("user");
    if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const { departmentIds } = c.req.query();
    const parsedDepartmentIds = departmentIds
      ? departmentIds.split(",").map(Number)
      : undefined;

    const where = parsedDepartmentIds
      ? {
          clinics: {
            some: {
              id: user.role === Role.SUPER_ADMIN ? undefined : user.clinic.id,
            },
          },
          departments: {
            some: {
              id: {
                in: parsedDepartmentIds,
              },
            },
          },
        }
      : {
          clinics: {
            some: {
              id: user.role === Role.SUPER_ADMIN ? undefined : user.clinic.id,
            },
          },
        };

    const products = await db.product.findMany({
      where,
      select: {
        id: true,
        name: true,
        code: true,
        category: true,
        basePrice: true,
        departments: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return c.json({
      status: httpCodes.OK,
      message: "Products list fetched successfully",
      data: products,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getProductsListWithPricing = async (c: Context) => {
  try {
    const user = c.get("user");
    if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const { departmentIds } = c.req.query();
    const parsedDepartmentIds = departmentIds
      ? departmentIds.split(",").map(Number)
      : undefined;

    const where = parsedDepartmentIds
      ? {
          clinics: {
            some: {
              id: user.role === Role.SUPER_ADMIN ? undefined : user.clinic.id,
            },
          },
          departments: {
            some: {
              id: {
                in: parsedDepartmentIds,
              },
            },
          },
        }
      : {
          clinics: {
            some: {
              id: user.role === Role.SUPER_ADMIN ? undefined : user.clinic.id,
            },
          },
        };

    const products = await db.product.findMany({
      where,
      select: {
        id: true,
        name: true,
        code: true,
        category: true,
        basePrice: true,
        insurancePrices: {
          select: {
            id: true,
            price: true,
            priceWithCo: true,
            priceType: true,
            insuranceCompany: {
              select: {
                id: true,
                companyName: true,
              },
            },
          },
        },
        departments: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return c.json({
      status: httpCodes.OK,
      message: "Products list with pricing fetched successfully",
      data: products,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getProductById = async (c: Context) => {
  try {
    const user = c.get("user");
    if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const { id } = c.get("validatedParam");
    const productId = Number.parseInt(id, 10);

    const product = await db.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        name: true,
        code: true,
        description: true,
        category: true,
        basePrice: true,
        foreignersPrice: true,
        unit: true,
        normalRange: true,
        consumables: true,
        isActive: true,
        departments: {
          select: {
            id: true,
            name: true,
          },
        },
        clinics: {
          select: {
            id: true,
            name: true,
          },
        },
        insurancePrices: {
          select: {
            id: true,
            price: true,
            priceWithCo: true,
            priceType: true,
            insuranceCompany: {
              select: {
                id: true,
                companyName: true,
              },
            },
          },
        },
        updatedAt: true,
        createdAt: true,
      },
    });

    if (!product) {
      return c.json(
        { error: "Product not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    // Check if user has access to this product
    if (
      user.role !== Role.SUPER_ADMIN &&
      !product.clinics.some((clinic) => clinic.id === user.clinic.id)
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    return c.json({
      status: httpCodes.OK,
      message: "Product fetched successfully",
      data: product,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const createProduct = async (c: Context) => {
  try {
    const user = c.get("user");
    if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const validatedFields = createProductSchema.safeParse(await c.req.json());
    if (!validatedFields.success) {
      return c.json({
        error: validatedFields.error.flatten().fieldErrors,
        status: httpCodes.BAD_REQUEST,
      });
    }

    const {
      name,
      code,
      description,
      category,
      basePrice,
      foreignersPrice,
      unit,
      normalRange,
      consumables,
      departmentIds,
    } = validatedFields.data;

    // Check if product code already exists
    const existingProduct = await db.product.findUnique({
      where: { code },
    });

    if (existingProduct) {
      return c.json(
        { error: "Product with this code already exists" },
        httpCodes.CONFLICT as ContentfulStatusCode
      );
    }

    // Verify departments exist if provided (Department is global in backend schema)
    if (departmentIds && departmentIds.length > 0) {
      const departments = await db.department.findMany({
        where: { id: { in: departmentIds } },
      });
      if (departments.length !== departmentIds.length) {
        return c.json(
          { error: "One or more departments not found" },
          httpCodes.NOT_FOUND as ContentfulStatusCode
        );
      }
    }

    const product = await db.product.create({
      data: {
        name,
        code,
        description,
        category: category as ProductCategory,
        basePrice: basePrice ? basePrice : null,
        foreignersPrice: foreignersPrice ? foreignersPrice : null,
        unit,
        normalRange,
        consumables: consumables
          ? (consumables as Prisma.InputJsonValue)
          : undefined,
        clinics: {
          connect: { id: user.clinic.id },
        },
        departments: departmentIds
          ? {
              connect: departmentIds.map((id) => ({ id })),
            }
          : undefined,
      },
      include: {
        departments: {
          select: {
            id: true,
            name: true,
          },
        },
        clinics: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return c.json({
      status: httpCodes.CREATED,
      message: "Product created successfully",
      data: product,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updateProduct = async (c: Context) => {
  try {
    const user = c.get("user");
    if (!userHasTariffWriteAccess(user)) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const { id } = c.get("validatedParam");
    const productId = Number.parseInt(id, 10);

    const validatedFields = updateProductSchema.safeParse(await c.req.json());
    if (!validatedFields.success) {
      return c.json({
        error: validatedFields.error.flatten().fieldErrors,
        status: httpCodes.BAD_REQUEST,
      });
    }

    // Check if product exists and user has access
    const existingProduct = await db.product.findUnique({
      where: { id: productId },
      include: { clinics: { select: { id: true } } },
    });

    if (!existingProduct) {
      return c.json(
        { error: "Product not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (!userCanAccessProduct(user, existingProduct)) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    // Check if new code conflicts with existing products
    if (
      await isProductCodeConflicting(
        validatedFields.data.code,
        existingProduct.code
      )
    ) {
      return c.json(
        { error: "Product with this code already exists" },
        httpCodes.CONFLICT as ContentfulStatusCode
      );
    }

    // Verify departments exist if provided (Department is global in backend schema)
    const departmentIdsInput = validatedFields.data.departmentIds;
    if (departmentIdsInput && departmentIdsInput.length > 0) {
      const ok = await departmentsExistByIds(departmentIdsInput);
      if (!ok) {
        return c.json(
          { error: "One or more departments not found" },
          httpCodes.NOT_FOUND as ContentfulStatusCode
        );
      }
    }

    const updatedProduct = await db.product.update({
      where: { id: productId },
      data: {
        ...validatedFields.data,
        category: validatedFields.data.category as ProductCategory,
        consumables: validatedFields.data.consumables
          ? (validatedFields.data.consumables as Prisma.InputJsonValue)
          : undefined,
        departments: validatedFields.data.departmentIds
          ? {
              set: validatedFields.data.departmentIds.map((departmentId) => ({
                id: departmentId,
              })),
            }
          : undefined,
      },
      include: {
        departments: {
          select: {
            id: true,
            name: true,
          },
        },
        clinics: {
          select: {
            id: true,
            name: true,
          },
        },
        insurancePrices: {
          select: {
            id: true,
            price: true,
            priceWithCo: true,
            priceType: true,
            insuranceCompany: {
              select: {
                id: true,
                companyName: true,
              },
            },
          },
        },
      },
    });

    return c.json({
      status: httpCodes.OK,
      message: "Product updated successfully",
      data: updatedProduct,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updateProductPricing = async (c: Context) => {
  try {
    const user = c.get("user");
    if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const { id } = c.get("validatedParam");
    const productId = Number.parseInt(id, 10);

    const validatedFields = updateProductPricingSchema.safeParse(
      await c.req.json()
    );
    if (!validatedFields.success) {
      return c.json({
        error: validatedFields.error.flatten().fieldErrors,
        status: httpCodes.BAD_REQUEST,
      });
    }

    // Check if product exists and user has access
    const existingProduct = await db.product.findUnique({
      where: { id: productId },
      include: {
        clinics: {
          select: { id: true },
        },
      },
    });

    if (!existingProduct) {
      return c.json(
        { error: "Product not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (
      user.role !== Role.SUPER_ADMIN &&
      !existingProduct.clinics.some((clinic) => clinic.id === user.clinic.id)
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const { basePrice, insurancePrices } = validatedFields.data;

    // Verify insurance companies exist (no clinic relation in backend schema)
    const insuranceCompanyIds = insurancePrices.map((ip) =>
      Number.parseInt(ip.companyId, 10)
    );
    const insuranceCompanies = await db.insuranceCompany.findMany({
      where: { id: { in: insuranceCompanyIds } },
    });

    if (insuranceCompanies.length !== insuranceCompanyIds.length) {
      return c.json(
        { error: "One or more insurance companies not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const updatedProduct = await db.product.update({
      where: { id: productId },
      data: {
        basePrice,
        insurancePrices: {
          deleteMany: {},
          createMany: {
            data: insurancePrices.map((ip) => ({
              price: ip.price,
              insuranceCompanyId: Number.parseInt(ip.companyId, 10),
            })),
          },
        },
      },
      include: {
        departments: {
          select: {
            id: true,
            name: true,
          },
        },
        clinics: {
          select: {
            id: true,
            name: true,
          },
        },
        insurancePrices: {
          select: {
            id: true,
            price: true,
            priceWithCo: true,
            priceType: true,
            insuranceCompany: {
              select: {
                id: true,
                companyName: true,
              },
            },
          },
        },
      },
    });

    return c.json({
      status: httpCodes.OK,
      message: "Product pricing updated successfully",
      data: updatedProduct,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getConsultationProducts = async (c: Context) => {
  try {
    const user = c.get("user");
    if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const products = await db.product.findMany({
      where: {
        clinics: { some: { id: user.clinic.id } },
        OR: [
          {
            departments: {
              some: {
                name: { in: ["CONSULTATION"] },
              },
            },
          },
          {
            name: {
              in: [
                "CONSULTATION",
                "GENERAL CONSULTATION",
                "SPECIALIST CONSULTATION",
              ],
              mode: "insensitive",
            },
          },
        ],
      },
      select: {
        id: true,
        name: true,
        basePrice: true,
      },
    });

    return c.json({
      status: httpCodes.OK,
      message: "Consultation products fetched successfully",
      data: products,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getConsultationProductsWithPricing = async (c: Context) => {
  try {
    const user = c.get("user");
    if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const products = await db.product.findMany({
      where: {
        clinics: { some: { id: user.clinic.id } },
        OR: [
          {
            departments: {
              some: {
                name: { in: ["CONSULTATION"] },
              },
            },
          },
          {
            name: {
              in: [
                "CONSULTATION",
                "GENERAL CONSULTATION",
                "SPECIALIST CONSULTATION",
              ],
              mode: "insensitive",
            },
          },
        ],
      },
      select: {
        id: true,
        name: true,
        basePrice: true,
        insurancePrices: {
          select: {
            id: true,
            price: true,
            priceWithCo: true,
            priceType: true,
            insuranceCompany: {
              select: {
                id: true,
                companyName: true,
              },
            },
          },
        },
        departments: {
          select: {
            name: true,
          },
        },
      },
    });

    return c.json({
      status: httpCodes.OK,
      message: "Consultation products with pricing fetched successfully",
      data: products,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const importProductsFromCSV = async (c: Context) => {
  try {
    const user = c.get("user");
    if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const validatedFields = importProductsSchema.safeParse(await c.req.json());
    if (!validatedFields.success) {
      return c.json({
        error: validatedFields.error.flatten().fieldErrors,
        status: httpCodes.BAD_REQUEST,
      });
    }

    const { csvContent } = validatedFields.data;

    // Parse CSV content
    const records: ProductCSVRow[] = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
    });

    if (!records || records.length === 0) {
      return c.json(
        { error: "No valid records found in CSV" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    // Sort records to process parent products first (match frontend logic)
    const sortedRecords = [...records].sort((a, b) => {
      if (a["#"] && !b["#"]) {
        return -1;
      }
      if (!a["#"] && b["#"]) {
        return 1;
      }
      return 0;
    });

    let successfulImports = 0;
    let failedImports = 0;
    const errors: string[] = [];

    const BATCH_SIZE = 20;
    // Process records in batches
    for (let i = 0; i < sortedRecords.length; i += BATCH_SIZE) {
      const batch = sortedRecords.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (record) => {
          try {
            return await processRecord(user.clinic.id)(record);
          } catch (error) {
            logger.error(`Error processing product ${record.NAME}:`, { error });
            return null;
          }
        })
      );

      // Count successes and failures
      const batchSuccesses = results.filter(Boolean).length;
      successfulImports += batchSuccesses;
      failedImports += batch.length - batchSuccesses;

      // Add a small delay between batches to prevent overwhelming the connection pool
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return c.json({
      status: httpCodes.OK,
      message: `Successfully imported ${successfulImports} products`,
      data: {
        successfulImports,
        failedImports,
        errors: errors.slice(0, 10), // Limit errors to first 10
      },
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

// Helper function to process individual CSV records (matches original structure)
function processRecord(clinicId: number) {
  return async (record: ProductCSVRow) => {
    try {
      const existingProduct = await findExistingProduct(record.NAME);
      if (existingProduct) {
        const formattedProduct = {
          ...existingProduct,
          insurancePrices: existingProduct.insurancePrices.map((ip) => ({
            ...ip,
            price: Number(ip.price),
            priceWithCo: Number(ip.priceWithCo),
          })),
          basePrice: Number(existingProduct.basePrice),
          foreignersPrice: Number(existingProduct.foreignersPrice),
          unit: existingProduct.unit || undefined,
          normalRange: existingProduct.normalRange || undefined,
          consumables: existingProduct.consumables || undefined,
          clinics: existingProduct.clinics,
        };
        return handleExistingProduct(formattedProduct, record, clinicId);
      }
      const newProduct = await createNewProduct(record, clinicId);
      await createInitialInsurancePricesForNewProduct(newProduct.id, {
        tariff: Number.parseFloat(record.TARIFF),
        tariffWithCo: Number.parseFloat(record.TARIFF_WITH_CO as string),
        govTariff: Number.parseFloat(record.GOV_INSURANCE as string),
      });
      return true;
    } catch (error) {
      logger.error(`Error processing product ${record.NAME}:`, { error });
      return null;
    }
  };
}
