import { parse } from "csv-parse/sync";
import type { Context } from "hono";
import {
  PriceType,
  type Prisma,
  type Product,
  type ProductCategory,
  Role,
} from "../../../../generated/prisma/client";
import { db } from "../../../database/db";
import { buildQueryOptions } from "../../../helpers/query-helper";
import {
  createNewInsurancePrice,
  createNewProduct,
  findExistingProductsByNames,
  getInsuranceCompaniesMap,
  getTargetClinicId,
  handleExistingProduct,
  type IExistingProduct,
  type ProductCSVRow,
} from "../../../helpers/tariff-helpers";
import { jsonSuccess } from "../../../lib/api-response";
import { AppError } from "../../../lib/app-error";
import { searchParamsSchema } from "../../../lib/common-validation";
import {
  httpCodes,
  InsuranceCompanies,
  SpecialInsurers,
} from "../../../lib/constants";
import { logger } from "../../../lib/logger";
import { getScope } from "../../../lib/request-scope";
import type { AppEnv } from "../../../middlewares/auth.middleware";
import type {
  CreateProductData,
  ImportProductsData,
  UpdateProductData,
  UpdateProductPricingData,
} from "./tariff.validation";

// Small helpers to keep handlers simple (reduce complexity)
function userHasTariffWriteAccess(user: { role: Role }) {
  return user.role === Role.CLINIC_ADMIN || user.role === Role.SUPER_ADMIN;
}

const TERMINOLOGY_FIELDS = [
  "icd11Code",
  "loincCode",
  "snomedCode",
  "rxNormCode",
  "ichiCode",
  "nationalTariffCode",
] as const;

function containsLegacyTerminologyFields(data: object): boolean {
  return TERMINOLOGY_FIELDS.some(
    (field) => field in data && data[field as keyof typeof data] !== undefined
  );
}

const terminologyWarningMeta = (ignored: boolean) =>
  ignored
    ? {
        warnings: [
          {
            code: "TERMINOLOGY_MANAGED_BY_PLATFORM",
          },
        ],
      }
    : undefined;

function tariffError(status: number, code: string, message: string): never {
  throw new AppError({ status, code, message, exposeMessage: true });
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

async function syncClinicSpecificPricingFromProductUpdate({
  productId,
  clinicId,
  data,
}: {
  productId: number;
  clinicId?: number;
  data: UpdateProductData;
}) {
  if (!clinicId) {
    return;
  }

  const hasPricingFields =
    "basePrice" in data ||
    "eastAfricaPrice" in data ||
    "africaPrice" in data ||
    "restOfWorldPrice" in data;

  if (!hasPricingFields) {
    return;
  }

  await db.clinicProductPrice.upsert({
    where: {
      clinicId_productId: {
        clinicId,
        productId,
      },
    },
    update: {
      ...(data.basePrice !== undefined ? { basePrice: data.basePrice } : {}),
      ...(data.eastAfricaPrice !== undefined
        ? { eastAfricaPrice: data.eastAfricaPrice }
        : {}),
      ...(data.africaPrice !== undefined
        ? { africaPrice: data.africaPrice }
        : {}),
      ...(data.restOfWorldPrice !== undefined
        ? { restOfWorldPrice: data.restOfWorldPrice }
        : {}),
    },
    create: {
      clinicId,
      productId,
      basePrice: data.basePrice ?? null,
      eastAfricaPrice: data.eastAfricaPrice ?? null,
      africaPrice: data.africaPrice ?? null,
      restOfWorldPrice: data.restOfWorldPrice ?? null,
    },
  });
}

async function createInitialInsurancePricesForNewProduct(
  productId: number,
  tariffs: { tariff: number; tariffWithCo: number; govTariff: number },
  clinicId: number,
  companyMap?: Map<string, number>
) {
  const { tariff, tariffWithCo, govTariff } = tariffs;

  // Process private insurance companies
  const hasTariff = !Number.isNaN(tariff);
  const hasTariffWithCo = !Number.isNaN(tariffWithCo);

  if (hasTariff || hasTariffWithCo) {
    for (const insuranceCompanyName of Object.values(InsuranceCompanies)) {
      await createNewInsurancePrice({
        productId,
        price: Number.isNaN(tariff) ? 0 : tariff,
        insuranceCompanyName,
        priceType: PriceType.PRIVATE,
        priceWithCo: Number.isNaN(tariffWithCo) ? undefined : tariffWithCo,
        clinicId,
        companyMap,
      });
    }
  }

  // Process government/special insurers
  if (!Number.isNaN(govTariff)) {
    for (const insuranceCompanyName of Object.values(SpecialInsurers)) {
      await createNewInsurancePrice({
        productId,
        price: govTariff,
        insuranceCompanyName,
        priceType: PriceType.GOV,
        clinicId,
        companyMap,
      });
    }
  }
}

export const getTariff = async (c: Context<AppEnv>): Promise<Response> => {
  try {
    const user = c.get("user");
    if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
      tariffError(httpCodes.FORBIDDEN, "FORBIDDEN", "Forbidden");
    }

    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId } = getScope(user, params);
    const targetClinicId = getTargetClinicId(user, clinicId);
    const queryOptions = buildQueryOptions<Product>(params);
    const { where, orderBy, ...restOptions } = queryOptions;

    if (!targetClinicId) {
      tariffError(httpCodes.FORBIDDEN, "CLINIC_NOT_FOUND", "Clinic not found");
    }

    const clinicFilter = targetClinicId
      ? { clinics: { some: { id: targetClinicId } } }
      : {}; // Explicitly show all products when targetClinicId is undefined

    const products = await db.product.findMany({
      ...restOptions,
      where: {
        ...where,
        ...clinicFilter,
      } as Prisma.ProductWhereInput,
      orderBy: orderBy as Prisma.ProductOrderByWithRelationInput,
      select: {
        id: true,
        name: true,
        code: true,
        category: true,
        basePrice: true,
        eastAfricaPrice: true,
        africaPrice: true,
        restOfWorldPrice: true,
        clinicProductPrices: {
          where: {
            clinicId: targetClinicId,
          },
          select: {
            basePrice: true,
            eastAfricaPrice: true,
            africaPrice: true,
            restOfWorldPrice: true,
          },
          take: 1,
        },
        unit: true,
        normalRange: true,
        icd11Code: true,
        loincCode: true,
        snomedCode: true,
        rxNormCode: true,
        ichiCode: true,
        nationalTariffCode: true,
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
            insurerItemCode: true,
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
            id: targetClinicId,
          },
        },
      } as Prisma.ProductWhereInput,
    });

    const pageCount = restOptions.take
      ? Math.ceil(totalCount / restOptions.take)
      : 0;

    const productsWithPricing = products.map((product) => {
      const clinicPrice = product.clinicProductPrices?.[0];
      return {
        ...product,
        basePrice: clinicPrice?.basePrice ?? product.basePrice,
        eastAfricaPrice:
          clinicPrice?.eastAfricaPrice ?? product.eastAfricaPrice,
        africaPrice: clinicPrice?.africaPrice ?? product.africaPrice,
        restOfWorldPrice:
          clinicPrice?.restOfWorldPrice ?? product.restOfWorldPrice,
        clinicProductPrices: undefined,
      };
    });

    return jsonSuccess(c, {
      status: httpCodes.OK,
      message: "Tariff fetched successfully",
      data: productsWithPricing,
      meta: { totalCount, pageCount },
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    tariffError(
      httpCodes.INTERNAL_SERVER_ERROR,
      "INTERNAL_SERVER_ERROR",
      "Internal Server Error"
    );
  }
};

export const getProductsList = async (
  c: Context<AppEnv>
): Promise<Response> => {
  try {
    const user = c.get("user");
    if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
      tariffError(httpCodes.FORBIDDEN, "FORBIDDEN", "Forbidden");
    }

    const { departmentIds } = c.req.query();
    const parsedDepartmentIdsRaw = departmentIds
      ? departmentIds
          .split(".")
          .map((token) => Number(token.trim()))
          .filter((id) => Number.isInteger(id) && id > 0)
      : [];
    const parsedDepartmentIds =
      parsedDepartmentIdsRaw.length > 0 ? parsedDepartmentIdsRaw : undefined;

    const { clinicId } = getScope(user, c.req.query());
    let targetClinicId: number | undefined;
    if (typeof clinicId === "number") {
      targetClinicId = clinicId;
    } else if (user.role !== Role.SUPER_ADMIN) {
      targetClinicId = user.clinicId;
    }
    const where = parsedDepartmentIds
      ? {
          clinics: {
            some: {
              id: targetClinicId,
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
              id: targetClinicId,
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
        icd11Code: true,
        loincCode: true,
        snomedCode: true,
        rxNormCode: true,
        ichiCode: true,
        nationalTariffCode: true,
        departments: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return jsonSuccess(c, {
      status: httpCodes.OK,
      message: "Products list fetched successfully",
      data: products,
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    tariffError(
      httpCodes.INTERNAL_SERVER_ERROR,
      "INTERNAL_SERVER_ERROR",
      "Internal Server Error"
    );
  }
};

export const getProductsListWithPricing = async (
  c: Context<AppEnv>
): Promise<Response> => {
  try {
    const user = c.get("user");

    const { departmentIds } = c.req.query();
    const parsedDepartmentIdsRaw = departmentIds
      ? departmentIds.split(".").map(Number).filter(Number.isFinite)
      : [];
    const parsedDepartmentIds =
      parsedDepartmentIdsRaw.length > 0 ? parsedDepartmentIdsRaw : undefined;

    const { clinicId } = getScope(user, c.req.query());
    let targetClinicId: number | undefined;
    if (typeof clinicId === "number") {
      targetClinicId = clinicId;
    } else if (user.role !== Role.SUPER_ADMIN) {
      targetClinicId = user.clinicId;
    }
    const where = parsedDepartmentIds
      ? {
          clinics: {
            some: {
              id: targetClinicId,
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
              id: targetClinicId,
            },
          },
        };

    const scopedClinicId = targetClinicId;

    const products = await db.product.findMany({
      where,
      select: {
        id: true,
        name: true,
        code: true,
        category: true,
        basePrice: true,
        eastAfricaPrice: true,
        africaPrice: true,
        restOfWorldPrice: true,
        icd11Code: true,
        loincCode: true,
        snomedCode: true,
        rxNormCode: true,
        ichiCode: true,
        nationalTariffCode: true,
        clinicProductPrices: scopedClinicId
          ? {
              where: {
                clinicId: scopedClinicId,
              },
              select: {
                basePrice: true,
                eastAfricaPrice: true,
                africaPrice: true,
                restOfWorldPrice: true,
              },
              take: 1,
            }
          : undefined,
        insurancePrices: {
          where: scopedClinicId
            ? {
                OR: [{ clinicId: scopedClinicId }, { clinicId: null }],
              }
            : undefined,
          select: {
            id: true,
            price: true,
            priceWithCo: true,
            priceType: true,
            insurerItemCode: true,
            clinicId: true,
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

    // Transform products to include clinic-specific prices with fallback
    const productsWithPricing = products.map((product) => {
      const clinicPrice = product.clinicProductPrices?.[0];
      return {
        ...product,
        basePrice: clinicPrice?.basePrice ?? product.basePrice,
        eastAfricaPrice:
          clinicPrice?.eastAfricaPrice ?? product.eastAfricaPrice,
        africaPrice: clinicPrice?.africaPrice ?? product.africaPrice,
        restOfWorldPrice:
          clinicPrice?.restOfWorldPrice ?? product.restOfWorldPrice,
        // Filter insurance prices to prefer clinic-specific, then global
        insurancePrices: scopedClinicId
          ? (() => {
              const clinicSpecific = product.insurancePrices.filter(
                (ip) => ip.clinicId === scopedClinicId
              );
              const global = product.insurancePrices.filter(
                (ip) => ip.clinicId === null
              );
              // Merge: clinic-specific first, then global for missing companies
              const clinicCompanyIds = new Set(
                clinicSpecific.map((ip) => ip.insuranceCompany.id)
              );
              const globalOnly = global.filter(
                (ip) => !clinicCompanyIds.has(ip.insuranceCompany.id)
              );
              return [...clinicSpecific, ...globalOnly];
            })()
          : product.insurancePrices,
        clinicProductPrices: undefined, // Remove from response
      };
    });

    return jsonSuccess(c, {
      status: httpCodes.OK,
      message: "Products list with pricing fetched successfully",
      data: productsWithPricing,
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    tariffError(
      httpCodes.INTERNAL_SERVER_ERROR,
      "INTERNAL_SERVER_ERROR",
      "Internal Server Error"
    );
  }
};

export const getProductById = async (c: Context<AppEnv>): Promise<Response> => {
  try {
    const user = c.get("user");
    if (!userHasTariffWriteAccess(user)) {
      tariffError(httpCodes.FORBIDDEN, "FORBIDDEN", "Forbidden");
    }

    const { id } = c.get("validatedParam");
    const productId = Number.parseInt(id, 10);
    const clinicId = user.role === Role.SUPER_ADMIN ? undefined : user.clinicId;

    const product = await db.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        name: true,
        code: true,
        description: true,
        category: true,
        basePrice: true,
        eastAfricaPrice: true,
        africaPrice: true,
        restOfWorldPrice: true,
        unit: true,
        normalRange: true,
        icd11Code: true,
        loincCode: true,
        snomedCode: true,
        rxNormCode: true,
        ichiCode: true,
        nationalTariffCode: true,
        consumables: true,
        isActive: true,
        clinicProductPrices: clinicId
          ? {
              where: {
                clinicId,
              },
              select: {
                basePrice: true,
                eastAfricaPrice: true,
                africaPrice: true,
                restOfWorldPrice: true,
              },
              take: 1,
            }
          : undefined,
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
          where: clinicId
            ? {
                OR: [{ clinicId }, { clinicId: null }],
              }
            : undefined,
          select: {
            id: true,
            price: true,
            priceWithCo: true,
            priceType: true,
            insurerItemCode: true,
            clinicId: true,
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
      tariffError(
        httpCodes.NOT_FOUND,
        "PRODUCT_NOT_FOUND",
        "Product not found"
      );
    }

    // Check if user has access to this product
    if (!userCanAccessProduct(user, product)) {
      tariffError(httpCodes.FORBIDDEN, "FORBIDDEN", "Forbidden");
    }

    // Transform product to include clinic-specific prices with fallback
    const clinicPrice = product.clinicProductPrices?.[0];
    const transformedProduct = {
      ...product,
      basePrice: clinicPrice?.basePrice ?? product.basePrice,
      eastAfricaPrice: clinicPrice?.eastAfricaPrice ?? product.eastAfricaPrice,
      africaPrice: clinicPrice?.africaPrice ?? product.africaPrice,
      restOfWorldPrice:
        clinicPrice?.restOfWorldPrice ?? product.restOfWorldPrice,
      // Filter insurance prices to prefer clinic-specific, then global
      insurancePrices: clinicId
        ? (() => {
            const clinicSpecific = product.insurancePrices.filter(
              (ip) => ip.clinicId === clinicId
            );
            const global = product.insurancePrices.filter(
              (ip) => ip.clinicId === null
            );
            // Merge: clinic-specific first, then global for missing companies
            const clinicCompanyIds = new Set(
              clinicSpecific.map((ip) => ip.insuranceCompany.id)
            );
            const globalOnly = global.filter(
              (ip) => !clinicCompanyIds.has(ip.insuranceCompany.id)
            );
            return [...clinicSpecific, ...globalOnly];
          })()
        : product.insurancePrices,
      clinicProductPrices: undefined, // Remove from response
    };

    return jsonSuccess(c, {
      status: httpCodes.OK,
      message: "Product fetched successfully",
      data: transformedProduct,
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    tariffError(
      httpCodes.INTERNAL_SERVER_ERROR,
      "INTERNAL_SERVER_ERROR",
      "Internal Server Error"
    );
  }
};

export const createProduct = async (c: Context<AppEnv>): Promise<Response> => {
  const user = c.get("user");
  if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
    tariffError(httpCodes.FORBIDDEN, "FORBIDDEN", "Forbidden");
  }

  const { clinicId } = getScope(user, c.req.query());
  if (!clinicId) {
    tariffError(
      httpCodes.BAD_REQUEST,
      "CLINIC_SCOPE_REQUIRED",
      "Clinic scope is required to create a product"
    );
  }

  const validatedData = c.get("validatedJson") as CreateProductData | undefined;
  if (!validatedData) {
    tariffError(
      httpCodes.BAD_REQUEST,
      "INVALID_REQUEST_BODY",
      "Invalid request body"
    );
  }

  const {
    name,
    code,
    description,
    category,
    basePrice,
    eastAfricaPrice,
    africaPrice,
    restOfWorldPrice,
    unit,
    normalRange,
    consumables,
    departmentIds,
  } = validatedData;

  // Check if product code already exists
  const existingProduct = await db.product.findUnique({
    where: { code },
  });

  if (existingProduct) {
    tariffError(
      httpCodes.CONFLICT,
      "PRODUCT_CODE_EXISTS",
      "Product with this code already exists"
    );
  }

  // Verify departments exist if provided (Department is global in backend schema)
  if (departmentIds && departmentIds.length > 0) {
    const departments = await db.department.findMany({
      where: { id: { in: departmentIds } },
    });
    if (departments.length !== departmentIds.length) {
      tariffError(
        httpCodes.NOT_FOUND,
        "DEPARTMENT_NOT_FOUND",
        "One or more departments not found"
      );
    }
  }

  const product = await db.product.create({
    data: {
      name,
      code,
      description,
      category: category as ProductCategory,
      basePrice: basePrice ?? null,
      eastAfricaPrice: eastAfricaPrice ?? null,
      africaPrice: africaPrice ?? null,
      restOfWorldPrice: restOfWorldPrice ?? null,
      unit,
      normalRange,
      consumables: consumables
        ? (consumables as Prisma.InputJsonValue)
        : undefined,
      clinics: {
        connect: { id: clinicId },
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

  return jsonSuccess(c, {
    status: httpCodes.CREATED,
    message: "Product created successfully",
    data: product,
  });
};

export const updateProduct = async (c: Context<AppEnv>): Promise<Response> => {
  const user = c.get("user");
  if (!userHasTariffWriteAccess(user)) {
    tariffError(httpCodes.FORBIDDEN, "FORBIDDEN", "Forbidden");
  }

  const { id } = c.get("validatedParam");
  const productId = Number.parseInt(id, 10);
  const { clinicId: scopedClinicId } = getScope(user, c.req.query());

  const validatedData = c.get("validatedJson") as UpdateProductData | undefined;
  if (!validatedData) {
    tariffError(
      httpCodes.BAD_REQUEST,
      "INVALID_REQUEST_BODY",
      "Invalid request body"
    );
  }

  // Check if product exists and user has access
  const existingProduct = await db.product.findUnique({
    where: { id: productId },
    include: { clinics: { select: { id: true } } },
  });

  if (!existingProduct) {
    tariffError(httpCodes.NOT_FOUND, "PRODUCT_NOT_FOUND", "Product not found");
  }

  if (!userCanAccessProduct(user, existingProduct)) {
    tariffError(httpCodes.FORBIDDEN, "FORBIDDEN", "Forbidden");
  }

  // Check if new code conflicts with existing products
  if (
    await isProductCodeConflicting(validatedData.code, existingProduct.code)
  ) {
    tariffError(
      httpCodes.CONFLICT,
      "PRODUCT_CODE_EXISTS",
      "Product with this code already exists"
    );
  }

  // Verify departments exist if provided (Department is global in backend schema)
  const departmentIdsInput = validatedData.departmentIds;
  if (departmentIdsInput && departmentIdsInput.length > 0) {
    const ok = await departmentsExistByIds(departmentIdsInput);
    if (!ok) {
      tariffError(
        httpCodes.NOT_FOUND,
        "DEPARTMENT_NOT_FOUND",
        "One or more departments not found"
      );
    }
  }

  const updatedProduct = await db.product.update({
    where: { id: productId },
    data: {
      name: validatedData.name,
      code: validatedData.code,
      description: validatedData.description,
      category: validatedData.category as ProductCategory,
      basePrice: validatedData.basePrice,
      eastAfricaPrice: validatedData.eastAfricaPrice,
      africaPrice: validatedData.africaPrice,
      restOfWorldPrice: validatedData.restOfWorldPrice,
      unit: validatedData.unit,
      normalRange: validatedData.normalRange,
      isActive: validatedData.isActive,
      consumables: validatedData.consumables
        ? (validatedData.consumables as Prisma.InputJsonValue)
        : undefined,
      departments: validatedData.departmentIds
        ? {
            set: validatedData.departmentIds.map((departmentId) => ({
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
          insurerItemCode: true,
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

  // Keep clinic-specific tariff in sync for clients that still call /products/:id
  await syncClinicSpecificPricingFromProductUpdate({
    productId,
    clinicId: scopedClinicId,
    data: validatedData,
  });

  return jsonSuccess(c, {
    status: httpCodes.OK,
    message: "Product updated successfully",
    data: updatedProduct,
  });
};

export const updateProductPricing = async (
  c: Context<AppEnv>
): Promise<Response> => {
  const user = c.get("user");
  if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
    tariffError(httpCodes.FORBIDDEN, "FORBIDDEN", "Forbidden");
  }

  const { id } = c.get("validatedParam");
  const productId = Number.parseInt(id, 10);
  const { clinicId: scopedClinicId } = getScope(user, c.req.query());
  const clinicId = scopedClinicId;

  if (!clinicId) {
    tariffError(
      httpCodes.BAD_REQUEST,
      "CLINIC_SCOPE_REQUIRED",
      "Clinic scope is required to update product pricing"
    );
  }

  const validatedData = c.get("validatedJson") as
    | UpdateProductPricingData
    | undefined;
  if (!validatedData) {
    tariffError(
      httpCodes.BAD_REQUEST,
      "INVALID_REQUEST_BODY",
      "Invalid request body"
    );
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
    tariffError(httpCodes.NOT_FOUND, "PRODUCT_NOT_FOUND", "Product not found");
  }

  if (
    user.role !== Role.SUPER_ADMIN &&
    !existingProduct.clinics.some((clinic) => clinic.id === clinicId)
  ) {
    tariffError(httpCodes.FORBIDDEN, "FORBIDDEN", "Forbidden");
  }

  const {
    basePrice,
    eastAfricaPrice,
    africaPrice,
    restOfWorldPrice,
    insurancePrices,
  } = validatedData;

  let insuranceCompanyIds: number[] = [];

  // Only replace insurance prices when payload explicitly includes them.
  if (insurancePrices) {
    insuranceCompanyIds = insurancePrices.map((ip) =>
      Number.parseInt(ip.companyId, 10)
    );
    if (insuranceCompanyIds.some(Number.isNaN)) {
      tariffError(
        httpCodes.BAD_REQUEST,
        "INSURANCE_COMPANY_ID_INVALID",
        "One or more insurance company IDs are invalid"
      );
    }

    // Verify insurance companies exist (no clinic relation in backend schema)
    const insuranceCompanies = await db.insuranceCompany.findMany({
      where: { id: { in: insuranceCompanyIds } },
    });

    if (insuranceCompanies.length !== insuranceCompanyIds.length) {
      tariffError(
        httpCodes.NOT_FOUND,
        "INSURANCE_COMPANY_NOT_FOUND",
        "One or more insurance companies not found"
      );
    }
  }

  await db.$transaction(async (tx) => {
    // Update or create clinic-specific product prices.
    await tx.clinicProductPrice.upsert({
      where: {
        clinicId_productId: {
          clinicId,
          productId,
        },
      },
      update: {
        basePrice: basePrice ?? null,
        eastAfricaPrice: eastAfricaPrice ?? null,
        africaPrice: africaPrice ?? null,
        restOfWorldPrice: restOfWorldPrice ?? null,
      },
      create: {
        clinicId,
        productId,
        basePrice: basePrice ?? null,
        eastAfricaPrice: eastAfricaPrice ?? null,
        africaPrice: africaPrice ?? null,
        restOfWorldPrice: restOfWorldPrice ?? null,
      },
    });

    if (insurancePrices) {
      // Delete existing insurance prices within the transaction to prevent races
      await tx.insurancePrice.deleteMany({
        where: {
          productId,
          clinicId,
        },
      });

      // Insert new clinic-specific insurance prices if provided
      if (insurancePrices.length > 0) {
        await tx.insurancePrice.createMany({
          data: insurancePrices.map((ip, index) => ({
            price: ip.price,
            priceWithCo: ip.priceWithCo ?? undefined,
            priceType: ip.priceType ?? PriceType.PRIVATE,
            insurerItemCode: ip.insurerItemCode ?? undefined,
            insuranceCompanyId: insuranceCompanyIds[index],
            productId,
            clinicId,
          })),
        });
      }
    }
  });

  // Fetch updated product with clinic-specific pricing
  const updatedProduct = await db.product.findUnique({
    where: { id: productId },
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
      clinicProductPrices: {
        where: {
          clinicId,
        },
        select: {
          basePrice: true,
          eastAfricaPrice: true,
          africaPrice: true,
          restOfWorldPrice: true,
        },
      },
      insurancePrices: {
        where: {
          clinicId,
        },
        select: {
          id: true,
          price: true,
          priceWithCo: true,
          priceType: true,
          insurerItemCode: true,
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

  return jsonSuccess(c, {
    status: httpCodes.OK,
    message: "Product pricing updated successfully",
    data: updatedProduct,
    meta: terminologyWarningMeta(
      containsLegacyTerminologyFields(validatedData)
    ),
  });
};

export const getConsultationProducts = async (
  c: Context<AppEnv>
): Promise<Response> => {
  try {
    const user = c.get("user");
    if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
      tariffError(httpCodes.FORBIDDEN, "FORBIDDEN", "Forbidden");
    }

    const products = await db.product.findMany({
      where: {
        clinics: { some: { id: user.clinicId } },
        OR: [
          {
            departments: {
              some: {
                name: {
                  in: [
                    "CONSULTATION",
                    "Consultation",
                    "Consultations",
                    "consultations",
                    "CONSULTATIONS",
                  ],
                },
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
        eastAfricaPrice: true,
        africaPrice: true,
        restOfWorldPrice: true,
        clinicProductPrices: {
          where: {
            clinicId: user.clinicId,
          },
          select: {
            basePrice: true,
            eastAfricaPrice: true,
            africaPrice: true,
            restOfWorldPrice: true,
          },
          take: 1,
        },
      },
    });

    const productsWithPricing = products.map((product) => {
      const clinicPrice = product.clinicProductPrices?.[0];
      return {
        ...product,
        basePrice: clinicPrice?.basePrice ?? product.basePrice,
        eastAfricaPrice:
          clinicPrice?.eastAfricaPrice ?? product.eastAfricaPrice,
        africaPrice: clinicPrice?.africaPrice ?? product.africaPrice,
        restOfWorldPrice:
          clinicPrice?.restOfWorldPrice ?? product.restOfWorldPrice,
        clinicProductPrices: undefined,
      };
    });

    //biome-ignore lint/suspicious/noConsole: <>
    console.log({ productsWithPricing });

    return jsonSuccess(c, {
      status: httpCodes.OK,
      message: "Consultation products fetched successfully",
      data: productsWithPricing,
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    tariffError(
      httpCodes.INTERNAL_SERVER_ERROR,
      "INTERNAL_SERVER_ERROR",
      "Internal Server Error"
    );
  }
};

export const getConsultationProductsWithPricing = async (
  c: Context<AppEnv>
): Promise<Response> => {
  try {
    const user = c.get("user");

    const products = await db.product.findMany({
      where: {
        clinics: { some: { id: user.clinicId } },
        OR: [
          {
            departments: {
              some: {
                name: {
                  in: [
                    "CONSULTATION",
                    "Consultation",
                    "Consultations",
                    "consultations",
                    "CONSULTATIONS",
                  ],
                },
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
        eastAfricaPrice: true,
        africaPrice: true,
        restOfWorldPrice: true,
        clinicProductPrices: {
          where: {
            clinicId: user.clinicId,
          },
          select: {
            basePrice: true,
            eastAfricaPrice: true,
            africaPrice: true,
            restOfWorldPrice: true,
          },
          take: 1,
        },
        insurancePrices: {
          select: {
            id: true,
            price: true,
            priceWithCo: true,
            priceType: true,
            insurerItemCode: true,
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

    const productsWithPricing = products.map((product) => {
      const clinicPrice = product.clinicProductPrices?.[0];
      return {
        ...product,
        basePrice: clinicPrice?.basePrice ?? product.basePrice,
        eastAfricaPrice:
          clinicPrice?.eastAfricaPrice ?? product.eastAfricaPrice,
        africaPrice: clinicPrice?.africaPrice ?? product.africaPrice,
        restOfWorldPrice:
          clinicPrice?.restOfWorldPrice ?? product.restOfWorldPrice,
        clinicProductPrices: undefined,
      };
    });

    return jsonSuccess(c, {
      status: httpCodes.OK,
      message: "Consultation products with pricing fetched successfully",
      data: productsWithPricing,
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    tariffError(
      httpCodes.INTERNAL_SERVER_ERROR,
      "INTERNAL_SERVER_ERROR",
      "Internal Server Error"
    );
  }
};

export const getLabProductsWithPricing = async (
  c: Context<AppEnv>
): Promise<Response> => {
  try {
    const user = c.get("user");

    const products = await db.product.findMany({
      where: {
        clinics: { some: { id: user.clinicId } },
        departments: {
          some: {
            name: { in: ["LABORATOIRE"] },
          },
        },
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        code: true,
        category: true,
        basePrice: true,
        eastAfricaPrice: true,
        africaPrice: true,
        restOfWorldPrice: true,
        clinicProductPrices: {
          where: {
            clinicId: user.clinicId,
          },
          select: {
            basePrice: true,
            eastAfricaPrice: true,
            africaPrice: true,
            restOfWorldPrice: true,
          },
          take: 1,
        },
        insurancePrices: {
          select: {
            id: true,
            price: true,
            priceWithCo: true,
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

    const productsWithPricing = products.map((product) => {
      const clinicPrice = product.clinicProductPrices?.[0];
      return {
        ...product,
        basePrice: clinicPrice?.basePrice ?? product.basePrice,
        eastAfricaPrice:
          clinicPrice?.eastAfricaPrice ?? product.eastAfricaPrice,
        africaPrice: clinicPrice?.africaPrice ?? product.africaPrice,
        restOfWorldPrice:
          clinicPrice?.restOfWorldPrice ?? product.restOfWorldPrice,
        clinicProductPrices: undefined,
      };
    });

    return jsonSuccess(c, {
      status: httpCodes.OK,
      message: "Lab products with pricing fetched successfully",
      data: productsWithPricing,
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    tariffError(
      httpCodes.INTERNAL_SERVER_ERROR,
      "INTERNAL_SERVER_ERROR",
      "Internal Server Error"
    );
  }
};

export const importProductsFromCSV = async (
  c: Context<AppEnv>
): Promise<Response> => {
  try {
    const user = c.get("user");
    if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
      tariffError(httpCodes.FORBIDDEN, "FORBIDDEN", "Forbidden");
    }

    // A SUPER_ADMIN carries no clinicId of their own, so the import has to run
    // against the scope resolved from the request (`?clinicId=`). Reading
    // `user.clinicId` here handed `undefined` to every product write below.
    const { clinicId } = getScope(user, c.req.query());
    if (!clinicId) {
      tariffError(
        httpCodes.BAD_REQUEST,
        "CLINIC_SCOPE_REQUIRED",
        "Clinic scope is required to import products"
      );
    }

    const validatedData = c.get("validatedJson") as
      | ImportProductsData
      | undefined;
    if (!validatedData) {
      tariffError(
        httpCodes.BAD_REQUEST,
        "INVALID_REQUEST_BODY",
        "Invalid request body"
      );
    }

    const { csvContent } = validatedData;

    // Fetch insurance companies map once for all records
    const companyMap = await getInsuranceCompaniesMap();

    // Parse CSV content
    const records: ProductCSVRow[] = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
    });

    if (!records || records.length === 0) {
      tariffError(
        httpCodes.BAD_REQUEST,
        "CSV_RECORDS_REQUIRED",
        "No valid records found in CSV"
      );
    }

    logger.info(`Starting product import: ${records.length} records found`);

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

    const BATCH_SIZE = 25;
    // Process records in batches
    for (let i = 0; i < sortedRecords.length; i += BATCH_SIZE) {
      const batch = sortedRecords.slice(i, i + BATCH_SIZE);
      logger.info(
        `Processing batch ${i / BATCH_SIZE + 1} (${batch.length} products)`
      );

      // Fetch all existing products for this batch in one call
      const existingProducts = await findExistingProductsByNames(
        batch.map((r) => r.NAME)
      );
      const existingProductsMap = new Map(
        existingProducts.map((p) => [p.name.toLowerCase(), p])
      );

      const results = await Promise.all(
        batch.map(async (record) => {
          try {
            const existingProduct = existingProductsMap.get(
              record.NAME.toLowerCase()
            );
            const startTime = Date.now();
            const result = await processRecord(
              clinicId,
              companyMap,
              existingProduct
            )(record);
            const duration = Date.now() - startTime;
            if (duration > 1000) {
              logger.warn(`Slow import for ${record.NAME}: ${duration}ms`);
            }
            return result;
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

      logger.info(
        `Batch ${i / BATCH_SIZE + 1} completed: ${batchSuccesses} successful, ${batch.length - batchSuccesses} failed`
      );

      // Add a small delay between batches to prevent overwhelming the connection pool
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 250);
      });
    }

    return jsonSuccess(c, {
      status: httpCodes.OK,
      message: `Successfully imported ${successfulImports} products`,
      data: {
        successfulImports,
        failedImports,
        errors: errors.slice(0, 10), // Limit errors to first 10
      },
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    tariffError(
      httpCodes.INTERNAL_SERVER_ERROR,
      "INTERNAL_SERVER_ERROR",
      "Internal Server Error"
    );
  }
};

// Helper function to process individual CSV records (matches original structure)
function processRecord(
  clinicId: number,
  companyMap: Map<string, number>,
  existingProduct?: IExistingProduct
) {
  return async (record: ProductCSVRow) => {
    try {
      if (existingProduct != null) {
        await handleExistingProduct(
          existingProduct,
          record,
          clinicId,
          companyMap
        );
        return true;
      }
      const newProduct = await createNewProduct(record, clinicId);
      await createInitialInsurancePricesForNewProduct(
        newProduct.id,
        {
          tariff: Number.parseFloat(record.TARIFF),
          tariffWithCo: Number.parseFloat(record.TARIFF_WITH_CO as string),
          govTariff: Number.parseFloat(record.GOV_INSURANCE as string),
        },
        clinicId,
        companyMap
      );
      return true;
    } catch (error) {
      logger.error(`Error processing product ${record.NAME}:`, { error });
      return null;
    }
  };
}
