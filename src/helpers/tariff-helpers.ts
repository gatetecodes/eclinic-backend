import {
  type ForeignerRegion,
  ItemType,
  PaymentMode,
  PaymentStatus,
  type PaymentType,
  PriceType,
  type Prisma,
  Role,
  Unit,
} from "../../generated/prisma/client";
import { db } from "../database/db";
import { InsuranceCompanies, SpecialInsurers } from "../lib/constants";
import { logger } from "../lib/logger";

const CONSUMABLES_REGEX = /^(.*?)\s*\(([^)]+)\)\s*$/;

// Types for CSV import
export type ProductCSVRow = {
  "#": string | undefined;
  NAME: string;
  CATEGORY: string;
  DEPARTMENT: string;
  UNIT?: string;
  NORMAL_RANGE?: string;
  TARIFF: string;
  GOV_INSURANCE?: string;
  TARIFF_WITH_CO?: string;
  PRIVATE_TARIFF: string;
  CONSUMABLES?: string;
  EAST_AFRICA?: string;
  AFRICA?: string;
  REST_OF_THE_WORLD?: string;
};

type MinimalProduct = { id: number; name: string };
type PaymentDetail = {
  productName: string;
  amount: number;
  patientAmount: number;
  insuranceAmount: number;
  productId: number;
  quantity: number;
};
type ProductForPayment = {
  id: number;
  name: string;
  basePrice: unknown;
  eastAfricaPrice: unknown;
  africaPrice: unknown;
  restOfWorldPrice: unknown;
  insurancePrices: {
    price: unknown;
    clinicId: number | null;
    insuranceCompany: { companyName: string };
  }[];
};
type VisitForPayment = {
  paymentMode: PaymentMode;
  patient: {
    nationality: string;
    isAForeigner: boolean;
    foreignerRegion: ForeignerRegion;
  };
  patientInsurance: {
    coveragePercentage: unknown;
    insuranceCompany: { companyName: string };
  } | null;
};

export type IExistingProduct = {
  id: number;
  name: string;
  category: string | null;
  basePrice: number;
  eastAfricaPrice: number;
  africaPrice: number;
  restOfWorldPrice: number;
  insurancePrices: {
    id: number;
    price: number;
    priceWithCo?: number;
    clinicId: number | null;
    insuranceCompany: { companyName: string };
  }[];
  unit?: string;
  normalRange?: string;
  consumables?: { name: string; quantity: string }[];
  clinics: { id: number }[];
};

type ParsedLabTest = {
  referenceNumber?: string;
  testName: string;
};

// Regex pattern for lab test parsing (defined at top level for performance)
const LAB_TEST_REGEX = /^\((\d+)\)(.+)$/;

// Helper function to get clinic-specific base price with fallback to global price
export const getClinicProductPrice = async (
  productId: number,
  clinicId: number
): Promise<{
  basePrice: number | null;
  eastAfricaPrice: number | null;
  africaPrice: number | null;
  restOfWorldPrice: number | null;
}> => {
  const clinicPrice = await db.clinicProductPrice.findUnique({
    where: {
      clinicId_productId: {
        clinicId,
        productId,
      },
    },
    select: {
      basePrice: true,
      eastAfricaPrice: true,
      africaPrice: true,
      restOfWorldPrice: true,
    },
  });

  const product = await db.product.findUnique({
    where: { id: productId },
    select: {
      basePrice: true,
      eastAfricaPrice: true,
      africaPrice: true,
      restOfWorldPrice: true,
    },
  });

  let basePrice: number | null = null;
  if (clinicPrice?.basePrice != null) {
    basePrice = Number(clinicPrice.basePrice);
  } else if (product?.basePrice != null) {
    basePrice = Number(product.basePrice);
  }

  let eastAfricaPrice: number | null = null;
  if (clinicPrice?.eastAfricaPrice != null) {
    eastAfricaPrice = Number(clinicPrice.eastAfricaPrice);
  } else if (product?.eastAfricaPrice != null) {
    eastAfricaPrice = Number(product.eastAfricaPrice);
  }

  let africaPrice: number | null = null;
  if (clinicPrice?.africaPrice != null) {
    africaPrice = Number(clinicPrice.africaPrice);
  } else if (product?.africaPrice != null) {
    africaPrice = Number(product.africaPrice);
  }

  let restOfWorldPrice: number | null = null;
  if (clinicPrice?.restOfWorldPrice != null) {
    restOfWorldPrice = Number(clinicPrice.restOfWorldPrice);
  } else if (product?.restOfWorldPrice != null) {
    restOfWorldPrice = Number(product.restOfWorldPrice);
  }

  return {
    basePrice,
    eastAfricaPrice,
    africaPrice,
    restOfWorldPrice,
  };
};

// Helper function to get clinic-specific insurance price with fallback to global price
export const getClinicInsurancePrice = async (
  productId: number,
  insuranceCompanyId: number,
  clinicId: number
): Promise<number | null> => {
  // Try clinic-specific insurance price first
  const clinicInsurancePrice = await db.insurancePrice.findUnique({
    where: {
      productId_insuranceCompanyId_clinicId: {
        productId,
        insuranceCompanyId,
        clinicId,
      },
    },
    select: {
      price: true,
    },
  });

  if (clinicInsurancePrice) {
    return Number(clinicInsurancePrice.price);
  }

  // Fallback to global insurance price (clinicId is NULL)
  const globalInsurancePrice = await db.insurancePrice.findFirst({
    where: {
      productId,
      insuranceCompanyId,
      clinicId: null,
    },
    select: {
      price: true,
    },
  });

  return globalInsurancePrice ? Number(globalInsurancePrice.price) : null;
};

// Helper function to parse lab test names with reference numbers
function parseLabTestName(name: string): ParsedLabTest {
  const match = name.match(LAB_TEST_REGEX);
  if (match) {
    return {
      referenceNumber: match[1],
      testName: match[2].trim(),
    };
  }
  return {
    testName: name.trim(),
  };
}

// Helper function to create or update lab tests
const createOrUpdateLabTest = async ({
  productId,
  testName,
  unit,
  normalRange,
  consumables,
}: {
  productId: number;
  testName: string;
  unit?: string;
  normalRange?: string;
  consumables?: { name: string; quantity: string }[];
}) => {
  // First check if a test with the same name and productId already exists
  const existingTest = await db.examTest.findFirst({
    where: {
      productId,
      name: testName,
    },
  });

  if (existingTest) {
    // If test exists, update it
    return db.examTest.update({
      where: { id: existingTest.id },
      data: {
        unit,
        normalRange,
        consumables,
      },
    });
  }

  // If no existing test found, create a new one
  return db.examTest.create({
    data: {
      name: testName,
      unit,
      normalRange,
      consumables,
      productId,
    },
  });
};

// Helper function to check if product is a parent
async function isParentProduct(referenceNumber: string) {
  const childTest = await db.product.findFirst({
    where: {
      code: {
        contains: `REF-${referenceNumber}`,
      },
    },
  });
  return Boolean(childTest);
}

// Helper function to get insurance company ID (trim + case-insensitive match; auto-create if missing)
async function getInsuranceCompanyId(
  companyName: string,
  companyMap?: Map<string, number>
) {
  const normalizedName = companyName.trim().replace(/\s+/g, " ");

  if (companyMap) {
    const id = companyMap.get(normalizedName.toLowerCase());
    if (id) {
      return id;
    }
  }

  // Try case-insensitive match first
  const existing = await db.insuranceCompany.findFirst({
    where: {
      companyName: {
        equals: normalizedName,
        mode: "insensitive",
      },
    },
    select: { id: true },
  });
  if (existing) {
    return existing.id;
  }
  // Auto-create when not found (handles new/misspelled entries). Normalize spacing.
  try {
    const created = await db.insuranceCompany.create({
      data: { companyName: normalizedName },
      select: { id: true },
    });
    logger.info("Created missing insurance company during pricing import", {
      companyName: normalizedName,
    });
    return created.id;
  } catch (_error) {
    // Handle race condition on unique constraint by re-reading
    const foundAfter = await db.insuranceCompany.findUnique({
      where: { companyName: normalizedName },
      select: { id: true },
    });
    if (foundAfter) {
      return foundAfter.id;
    }
    throw new Error("Insurance company not found");
  }
}

// Helper to get all insurance companies at once
export async function getInsuranceCompaniesMap() {
  const companies = await db.insuranceCompany.findMany({
    select: { id: true, companyName: true },
  });
  const map = new Map<string, number>();
  for (const company of companies) {
    map.set(
      company.companyName.trim().replace(/\s+/g, " ").toLowerCase(),
      company.id
    );
  }
  return map;
}

// Helper function to generate product code
export function generateProductCode(clinicId: number, productName: string) {
  const prefix = productName?.slice(0, 3) || "";
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  return `${clinicId}-${prefix}-${randomSuffix}`.toUpperCase();
}

// Helper function to add consumables to inventory
async function addConsumablesToInventory(
  consumables: { name: string; quantity: string }[],
  clinicId: number
) {
  const existingConsumables = await db.inventoryItem.findMany({
    where: {
      itemName: {
        in: consumables.map((consumable) => consumable.name),
      },
    },
  });

  // Skip existing consumables
  const newConsumables = consumables.filter(
    (consumable) =>
      !existingConsumables.some((c) => c.itemName === consumable.name)
  );

  await db.inventoryItem.createMany({
    data: newConsumables.map((consumable) => ({
      clinicId,
      itemName: consumable.name,
      itemType: ItemType.CONSUMABLE,
      reorderLevel: 50,
      unit: Unit.PIECE,
      minOrderQuantity: 0,
    })),
  });
}

// Main helper function to find existing products in a batch
export async function findExistingProductsByNames(
  names: string[]
): Promise<IExistingProduct[]> {
  const products = await db.product.findMany({
    where: { name: { in: names } },
    select: {
      id: true,
      name: true,
      category: true,
      insurancePrices: {
        select: {
          id: true,
          price: true,
          priceWithCo: true,
          clinicId: true,
          insuranceCompany: { select: { companyName: true } },
        },
      },
      unit: true,
      normalRange: true,
      basePrice: true,
      eastAfricaPrice: true,
      africaPrice: true,
      restOfWorldPrice: true,
      consumables: true,
      clinics: { select: { id: true } },
    },
  });

  return products.map((product) => ({
    ...product,
    basePrice: Number(product.basePrice) || 0,
    eastAfricaPrice: Number(product.eastAfricaPrice) || 0,
    africaPrice: Number(product.africaPrice) || 0,
    restOfWorldPrice: Number(product.restOfWorldPrice) || 0,
    unit: product.unit || undefined,
    normalRange: product.normalRange || undefined,
    consumables:
      (product.consumables as { name: string; quantity: string }[] | null) ||
      undefined,
    insurancePrices: product.insurancePrices.map((ip) => ({
      ...ip,
      price: Number(ip.price),
      priceWithCo: ip.priceWithCo ? Number(ip.priceWithCo) : undefined,
      clinicId: ip.clinicId,
    })),
  }));
}

// Helper function to create new insurance price
export const createNewInsurancePrice = async ({
  productId,
  price,
  insuranceCompanyName,
  priceType,
  priceWithCo,
  clinicId,
  companyMap,
}: {
  productId: number;
  price: number;
  insuranceCompanyName: string;
  priceType: PriceType;
  priceWithCo?: number;
  clinicId?: number;
  companyMap?: Map<string, number>;
}) => {
  try {
    const insuranceCompanyId = await getInsuranceCompanyId(
      insuranceCompanyName,
      companyMap
    );
    return db.insurancePrice.create({
      data: {
        productId,
        price,
        priceWithCo,
        insuranceCompanyId,
        priceType,
        clinicId: clinicId ?? null,
      },
    });
  } catch (_error) {
    logger.warn("Skipping insurance price creation: company not found", {
      insuranceCompanyName,
      productId,
      clinicId: clinicId ?? null,
    });
    return null;
  }
};

// Helper function to find clinic-specific insurance price
const findClinicInsurancePrice = (
  insurancePrices: IExistingProduct["insurancePrices"],
  companyName: string,
  clinicId: number
) => {
  return insurancePrices.find(
    (ip) =>
      ip.insuranceCompany.companyName === companyName &&
      ip.clinicId === clinicId
  );
};

// Helper function to find global insurance price
const findGlobalInsurancePrice = (
  insurancePrices: IExistingProduct["insurancePrices"],
  companyName: string
) => {
  return insurancePrices.find(
    (ip) =>
      ip.insuranceCompany.companyName === companyName && ip.clinicId === null
  );
};

// Helper functions to reduce complexity
const updateProductPricing = async ({
  productId,
  newPrivateTariff,
  newEastAfricaTariff,
  newAfricaTariff,
  newRestOfWorldTariff,
  clinicId,
}: {
  productId: number;
  newPrivateTariff: number;
  newEastAfricaTariff: number;
  newAfricaTariff: number;
  newRestOfWorldTariff: number;
  clinicId: number;
}) => {
  const updateData: {
    basePrice?: number | null;
    eastAfricaPrice?: number | null;
    africaPrice?: number | null;
    restOfWorldPrice?: number | null;
  } = {};
  const createData: {
    clinicId: number;
    productId: number;
    basePrice: number | null;
    eastAfricaPrice: number | null;
    africaPrice: number | null;
    restOfWorldPrice: number | null;
  } = {
    clinicId,
    productId,
    basePrice: null,
    eastAfricaPrice: null,
    africaPrice: null,
    restOfWorldPrice: null,
  };

  if (Number.isFinite(newPrivateTariff)) {
    updateData.basePrice = newPrivateTariff;
    createData.basePrice = newPrivateTariff;
  }
  if (Number.isFinite(newEastAfricaTariff)) {
    updateData.eastAfricaPrice = newEastAfricaTariff;
    createData.eastAfricaPrice = newEastAfricaTariff;
  }
  if (Number.isFinite(newAfricaTariff)) {
    updateData.africaPrice = newAfricaTariff;
    createData.africaPrice = newAfricaTariff;
  }
  if (Number.isFinite(newRestOfWorldTariff)) {
    updateData.restOfWorldPrice = newRestOfWorldTariff;
    createData.restOfWorldPrice = newRestOfWorldTariff;
  }

  await db.clinicProductPrice.upsert({
    where: {
      clinicId_productId: {
        clinicId,
        productId,
      },
    },
    update: updateData,
    create: createData,
  });
};

async function applyInsuranceUpdates(
  existingProduct: IExistingProduct,
  tariffs: {
    newTariff: number;
    newGovTariff: number;
    newTariffWithCo: number;
  },
  clinicId: number,
  companyMap?: Map<string, number>
) {
  const { newTariff, newGovTariff, newTariffWithCo } = tariffs;

  await updatePrivateInsurancePrices({
    existingProduct,
    newTariff,
    newTariffWithCo,
    clinicId,
    companyMap,
  });
  await updateGovInsurancePrices({
    existingProduct,
    newGovTariff,
    clinicId,
    companyMap,
  });
}

async function updatePrivateInsurancePrices({
  existingProduct,
  newTariff,
  newTariffWithCo,
  clinicId,
  companyMap,
}: {
  existingProduct: IExistingProduct;
  newTariff: number;
  newTariffWithCo: number;
  clinicId: number;
  companyMap?: Map<string, number>;
}) {
  const hasPricing =
    Number.isFinite(newTariff) || Number.isFinite(newTariffWithCo);

  if (!hasPricing) {
    return;
  }

  for (const companyName of Object.values(InsuranceCompanies)) {
    await updateSinglePrivateInsurancePrice({
      existingProduct,
      companyName,
      newTariff,
      newTariffWithCo,
      clinicId,
      companyMap,
    });
  }
}

async function updateSinglePrivateInsurancePrice({
  existingProduct,
  companyName,
  newTariff,
  newTariffWithCo,
  clinicId,
  companyMap,
}: {
  existingProduct: IExistingProduct;
  companyName: string;
  newTariff: number;
  newTariffWithCo: number;
  clinicId: number;
  companyMap?: Map<string, number>;
}) {
  const existingPrice = findClinicInsurancePrice(
    existingProduct.insurancePrices,
    companyName,
    clinicId
  );

  if (existingPrice) {
    // Only update if something actually changed
    const needsPriceUpdate =
      Number.isFinite(newTariff) &&
      Number(existingPrice.price) !== Number(newTariff);
    const needsCoUpdate =
      Number.isFinite(newTariffWithCo) &&
      Number(existingPrice.priceWithCo) !== Number(newTariffWithCo);

    if (needsPriceUpdate || needsCoUpdate) {
      await updateExistingInsurancePrice({
        existingPrice,
        newTariff: needsPriceUpdate ? newTariff : Number(existingPrice.price),
        newTariffWithCo: needsCoUpdate
          ? newTariffWithCo
          : Number(existingPrice.priceWithCo),
      });
    }
    return;
  }

  await createNewInsurancePriceFromGlobal({
    existingProduct,
    companyName,
    newTariff,
    newTariffWithCo,
    clinicId,
    companyMap,
  });
}

async function updateExistingInsurancePrice({
  existingPrice,
  newTariff,
  newTariffWithCo,
}: {
  existingPrice: { id: number };
  newTariff: number;
  newTariffWithCo: number;
}) {
  const updateData: Prisma.InsurancePriceUpdateInput = {};
  if (Number.isFinite(newTariff)) {
    updateData.price = newTariff;
  }
  if (Number.isFinite(newTariffWithCo)) {
    updateData.priceWithCo = newTariffWithCo;
  }

  if (Object.keys(updateData).length > 0) {
    await db.insurancePrice.update({
      where: { id: existingPrice.id },
      data: updateData,
    });
  }
}

// Helper to create new insurance price from global base
async function createNewInsurancePriceFromGlobal({
  existingProduct,
  companyName,
  newTariff,
  newTariffWithCo,
  clinicId,
  companyMap,
}: {
  existingProduct: IExistingProduct;
  companyName: string;
  newTariff: number;
  newTariffWithCo: number;
  clinicId: number;
  companyMap?: Map<string, number>;
}) {
  const globalPrice = findGlobalInsurancePrice(
    existingProduct.insurancePrices,
    companyName
  );

  let finalPrice = 0;
  let finalPriceWithCo: number | undefined;

  if (globalPrice) {
    finalPrice = Number.isFinite(newTariff)
      ? newTariff
      : Number(globalPrice.price);
    if (Number.isFinite(newTariffWithCo)) {
      finalPriceWithCo = newTariffWithCo;
    } else {
      finalPriceWithCo = globalPrice.priceWithCo
        ? Number(globalPrice.priceWithCo)
        : undefined;
    }
  } else {
    finalPrice = Number.isFinite(newTariff) ? newTariff : 0;
    finalPriceWithCo = Number.isFinite(newTariffWithCo)
      ? newTariffWithCo
      : undefined;
  }

  // ONLY create if either price is non-zero or defined
  if (finalPrice > 0 || finalPriceWithCo !== undefined) {
    await createNewInsurancePrice({
      productId: existingProduct.id,
      price: finalPrice,
      insuranceCompanyName: companyName,
      priceType: PriceType.PRIVATE,
      priceWithCo: finalPriceWithCo,
      clinicId,
      companyMap,
    });
  }
}

async function updateGovInsurancePrices({
  existingProduct,
  newGovTariff,
  clinicId,
  companyMap,
}: {
  existingProduct: IExistingProduct;
  newGovTariff: number;
  clinicId: number;
  companyMap?: Map<string, number>;
}) {
  if (!Number.isFinite(newGovTariff)) {
    return;
  }

  for (const companyName of Object.values(SpecialInsurers)) {
    const existingPrice = findClinicInsurancePrice(
      existingProduct.insurancePrices,
      companyName,
      clinicId
    );

    if (existingPrice) {
      if (Number(existingPrice.price) !== Number(newGovTariff)) {
        await db.insurancePrice.update({
          where: { id: existingPrice.id },
          data: { price: newGovTariff },
        });
      }
    } else {
      const globalPrice = findGlobalInsurancePrice(
        existingProduct.insurancePrices,
        companyName
      );

      const finalPrice = newGovTariff;
      const finalPriceWithCo = globalPrice?.priceWithCo
        ? Number(globalPrice.priceWithCo)
        : undefined;

      await createNewInsurancePrice({
        productId: existingProduct.id,
        price: finalPrice,
        insuranceCompanyName: companyName,
        priceType: PriceType.GOV,
        priceWithCo: finalPriceWithCo,
        clinicId,
        companyMap,
      });
    }
  }
}

const updateExamTest = async ({
  existingProduct,
  parsedName,
  newUnit,
  newNormalRange,
  newConsumables,
}: {
  existingProduct: IExistingProduct;
  parsedName: ParsedLabTest;
  newUnit?: string;
  newNormalRange?: string;
  newConsumables: { name: string; quantity: string }[];
}) => {
  const existingTest = await db.examTest.findFirst({
    where: {
      productId: existingProduct.id,
      name: parsedName.testName,
    },
  });

  if (existingTest) {
    await db.examTest.update({
      where: { id: existingTest.id },
      data: {
        unit: newUnit,
        normalRange: newNormalRange,
        consumables: newConsumables.length > 0 ? newConsumables : undefined,
      },
    });
  } else {
    await createOrUpdateLabTest({
      productId: existingProduct.id,
      testName: parsedName.testName,
      unit: newUnit,
      normalRange: newNormalRange,
      consumables: newConsumables,
    });
  }
};

const handleLabTestUpdates = async ({
  existingProduct,
  record,
  parsedName,
  newUnit,
  newNormalRange,
  newConsumables,
}: {
  existingProduct: IExistingProduct;
  record: ProductCSVRow;
  parsedName: ParsedLabTest;
  newUnit?: string;
  newNormalRange?: string;
  newConsumables: { name: string; quantity: string }[];
}) => {
  if (parsedName.referenceNumber) {
    // Child test - update/create ExamTest
    await updateExamTest({
      existingProduct,
      parsedName,
      newUnit,
      newNormalRange,
      newConsumables,
    });
  } else {
    // Parent or standalone test
    const hasChildren = record["#"]
      ? await isParentProduct(record["#"])
      : false;
    if (hasChildren) {
      // Parent with children - update at product level
      await db.product.update({
        where: { id: existingProduct.id },
        data: {
          unit: newUnit,
          normalRange: newNormalRange,
          consumables: newConsumables.length > 0 ? newConsumables : undefined,
        },
      });
    } else {
      // Standalone test - update/create ExamTest
      await updateExamTest({
        existingProduct,
        parsedName,
        newUnit,
        newNormalRange,
        newConsumables,
      });
    }
  }
};

// Helper function to handle existing product updates
export async function handleExistingProduct(
  existingProduct: IExistingProduct,
  record: ProductCSVRow,
  clinicId: number,
  companyMap?: Map<string, number>
) {
  const productUpdateData: Prisma.ProductUpdateInput = {};

  // 1. Connect clinic if missing
  const clinicIds = existingProduct.clinics.map((c) => c.id);
  if (!clinicIds.includes(clinicId)) {
    productUpdateData.clinics = {
      connect: { id: clinicId },
    };
  }

  const newTariff = Number.parseFloat(record.TARIFF);
  const newGovTariff = Number.parseFloat(record.GOV_INSURANCE as string);
  const newTariffWithCo = Number.parseFloat(record.TARIFF_WITH_CO as string);
  const newPrivateTariff = Number.parseFloat(record.PRIVATE_TARIFF as string);
  const newEastAfricaTariff = Number.parseFloat(record.EAST_AFRICA as string);
  const newAfricaTariff = Number.parseFloat(record.AFRICA as string);
  const newRestOfWorldTariff = Number.parseFloat(
    record.REST_OF_THE_WORLD as string
  );
  const newUnit = record.UNIT;
  const newNormalRange = record.NORMAL_RANGE;

  let newConsumables: { name: string; quantity: string }[] = [];

  if (record.CONSUMABLES) {
    newConsumables = record.CONSUMABLES.split(",").map((raw) => {
      const item = raw.trim();

      const m = item.match(CONSUMABLES_REGEX);
      if (!m) {
        return { name: item, quantity: "1" };
      }
      const [, name, qty] = m;
      return { name: name.trim(), quantity: qty.trim() };
    });
  }

  let newDepartments: string[] = [];
  if (record.DEPARTMENT) {
    newDepartments = record.DEPARTMENT.split(",").map((item) => {
      return item.trim();
    });
  }

  const isLabTest = newDepartments.includes("LABORATOIRE");
  const parsedName = isLabTest
    ? parseLabTestName(record.NAME)
    : { testName: record.NAME.trim() };

  // 2. Add departments to update data
  if (newDepartments.length > 0) {
    productUpdateData.departments = {
      connectOrCreate: newDepartments.map((department) => ({
        where: { name: department },
        create: { name: department },
      })),
    };
  }

  // 3. Handle insurance prices (these stay as separate calls for now but use pre-fetched map)
  await applyInsuranceUpdates(
    existingProduct,
    {
      newTariff,
      newGovTariff,
      newTariffWithCo,
    },
    clinicId,
    companyMap
  );

  // 4. Update clinic-specific product pricing
  try {
    await updateProductPricing({
      productId: existingProduct.id,
      newPrivateTariff,
      newEastAfricaTariff,
      newAfricaTariff,
      newRestOfWorldTariff,
      clinicId,
    });
  } catch (error) {
    logger.error(
      `Error updating product pricing for product ${existingProduct.id}:`,
      {
        error,
        input: {
          newPrivateTariff,
          newEastAfricaTariff,
          newAfricaTariff,
          newRestOfWorldTariff,
          clinicId,
        },
      }
    );
    throw error;
  }

  // 5. Handle lab test specific logic or update non-lab fields
  if (isLabTest) {
    await handleLabTestUpdates({
      existingProduct,
      record,
      parsedName,
      newUnit,
      newNormalRange,
      newConsumables,
    });
  } else {
    if (newUnit) {
      productUpdateData.unit = newUnit;
    }
    if (newNormalRange) {
      productUpdateData.normalRange = newNormalRange;
    }
    if (newConsumables.length > 0) {
      productUpdateData.consumables = newConsumables;
    }
  }

  // 6. Perform the combined product update if needed
  if (Object.keys(productUpdateData).length > 0) {
    await db.product.update({
      where: { id: existingProduct.id },
      data: productUpdateData,
    });
  }
}

// Small helpers to reduce complexity in createNewProduct
function parseConsumablesFromRecord(record: ProductCSVRow) {
  if (!record.CONSUMABLES) {
    return [] as { name: string; quantity: string }[];
  }
  return record.CONSUMABLES.split(",").map((raw) => {
    const item = raw.trim();

    const m = item.match(CONSUMABLES_REGEX);
    if (!m) {
      return { name: item, quantity: "1" };
    }
    const [, name, qty] = m;
    return { name: name.trim(), quantity: qty.trim() };
  });
}

function parseDepartmentsFromRecord(record: ProductCSVRow) {
  if (!record.DEPARTMENT) {
    return [] as string[];
  }
  return record.DEPARTMENT.split(",").map((item) => item.trim());
}

function buildProductCodeForRecord(
  clinicId: number,
  parsedName: ParsedLabTest,
  record: ProductCSVRow,
  isLabTest: boolean
) {
  const code = generateProductCode(clinicId, parsedName.testName);
  if (!isLabTest) {
    return code;
  }
  if (parsedName.referenceNumber) {
    return `REF-${parsedName.referenceNumber}-${code}`;
  }
  if (record["#"]) {
    return `PARENT-${record["#"]}-${code}`;
  }
  return code;
}

async function handleChildLabTestCreation(
  parsedName: ParsedLabTest,
  record: ProductCSVRow,
  clinicId: number,
  consumables: { name: string; quantity: string }[]
): Promise<MinimalProduct> {
  const parent = await db.product.findFirst({
    where: {
      clinics: { some: { id: clinicId } },
      code: { contains: `PARENT-${parsedName.referenceNumber}` },
    },
    select: { id: true, name: true },
  });
  if (!parent) {
    logger.info("No parent product found for child test", {
      childName: parsedName.testName,
      referenceNumber: parsedName.referenceNumber,
      searchedFor: `PARENT-${parsedName.referenceNumber}`,
    });
    throw new Error(
      `Parent product not found for reference number ${parsedName.referenceNumber}`
    );
  }
  logger.info("Creating ExamTest for child test", {
    parentProductId: parent.id,
    parentName: parent.name,
    childName: parsedName.testName,
    unit: record.UNIT,
    normalRange: record.NORMAL_RANGE,
  });
  await createOrUpdateLabTest({
    productId: parent.id,
    testName: parsedName.testName,
    unit: record.UNIT,
    normalRange: record.NORMAL_RANGE,
    consumables,
  });
  return parent;
}

async function handleParentOrStandaloneAfterCreation({
  createdProduct,
  isLabTest,
  parsedName,
  record,
  consumables,
}: {
  createdProduct: MinimalProduct;
  isLabTest: boolean;
  parsedName: ParsedLabTest;
  record: ProductCSVRow;
  consumables: { name: string; quantity: string }[];
}) {
  if (!isLabTest) {
    return;
  }
  if (!record["#"]) {
    return;
  }
  const referenceNumber = record["#"];
  const hasChildren = await db.product.findFirst({
    where: { code: { contains: `REF-${referenceNumber}` } },
    select: { id: true },
  });
  if (hasChildren) {
    logger.info("Created parent product (has children)", {
      name: record.NAME,
      productId: createdProduct.id,
      referenceNumber,
    });
    return;
  }
  logger.info("Creating parent product with ExamTest (no children)", {
    name: record.NAME,
    productId: createdProduct.id,
    referenceNumber,
  });
  await createOrUpdateLabTest({
    productId: createdProduct.id,
    testName: parsedName.testName,
    unit: record.UNIT,
    normalRange: record.NORMAL_RANGE,
    consumables,
  });
}

// Helper function to create new product
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Complex product creation logic with multiple conditional paths
export async function createNewProduct(
  record: ProductCSVRow,
  clinicId: number
) {
  const consumables = parseConsumablesFromRecord(record);

  await addConsumablesToInventory(consumables, clinicId);

  const departments = parseDepartmentsFromRecord(record);

  const isLabTest = departments.includes("LABORATOIRE");
  if (isLabTest) {
    const parsedName = parseLabTestName(record.NAME);
    logger.info("Processing Lab Test", {
      name: record.NAME,
      parsedName,
      hasReferenceInCSV: !!record["#"],
      unit: record.UNIT,
      normalRange: record.NORMAL_RANGE,
      departments,
    });
  }

  const parsedName = isLabTest
    ? parseLabTestName(record.NAME)
    : { testName: record.NAME.trim() };

  const productCode = buildProductCodeForRecord(
    clinicId,
    parsedName,
    record,
    isLabTest
  );
  if (isLabTest && !parsedName.referenceNumber && record["#"]) {
    logger.info("Creating parent product", {
      name: record.NAME,
      code: productCode,
      referenceNumber: record["#"],
    });
  }

  // Child test: link to existing parent and create ExamTest, then return parent
  if (isLabTest && parsedName.referenceNumber) {
    return handleChildLabTestCreation(
      parsedName,
      record,
      clinicId,
      consumables
    );
  }

  // Create regular or parent lab product, then handle standalone ExamTest case
  const createdProduct: MinimalProduct = await db.product.create({
    data: {
      clinics: { connect: { id: clinicId } },
      code: productCode,
      name: parsedName.testName,
      departments: {
        connectOrCreate: departments.map((department) => ({
          where: { name: department },
          create: { name: department },
        })),
      },
      // Keep basePrice and regional foreigner prices on Product as fallback, but create ClinicProductPrice for clinic-specific pricing
      basePrice: record.PRIVATE_TARIFF
        ? Number.parseFloat(record.PRIVATE_TARIFF)
        : undefined,
      consumables: isLabTest ? undefined : consumables,
      unit: record.UNIT || undefined,
      normalRange: record.NORMAL_RANGE || undefined,
      eastAfricaPrice: record.EAST_AFRICA
        ? Number.parseFloat(record.EAST_AFRICA)
        : undefined,
      africaPrice: record.AFRICA ? Number.parseFloat(record.AFRICA) : undefined,
      restOfWorldPrice: record.REST_OF_THE_WORLD
        ? Number.parseFloat(record.REST_OF_THE_WORLD)
        : undefined,
    },
    select: { id: true, name: true },
  });

  // Create clinic-specific pricing
  if (
    record.PRIVATE_TARIFF ||
    record.EAST_AFRICA ||
    record.AFRICA ||
    record.REST_OF_THE_WORLD
  ) {
    const pricingData = {
      clinicId,
      productId: createdProduct.id,
      basePrice: record.PRIVATE_TARIFF
        ? Number.parseFloat(record.PRIVATE_TARIFF)
        : null,
      eastAfricaPrice: record.EAST_AFRICA
        ? Number.parseFloat(record.EAST_AFRICA)
        : null,
      africaPrice: record.AFRICA ? Number.parseFloat(record.AFRICA) : null,
      restOfWorldPrice: record.REST_OF_THE_WORLD
        ? Number.parseFloat(record.REST_OF_THE_WORLD)
        : null,
    };

    try {
      await db.clinicProductPrice.create({
        data: pricingData,
      });
    } catch (error) {
      logger.error(
        `Error creating clinic product price for product ${createdProduct.id}:`,
        {
          error,
          pricingData,
          record: {
            PRIVATE_TARIFF: record.PRIVATE_TARIFF,
            EAST_AFRICA: record.EAST_AFRICA,
            AFRICA: record.AFRICA,
            REST_OF_THE_WORLD: record.REST_OF_THE_WORLD,
          },
        }
      );
      throw error;
    }
  }

  await handleParentOrStandaloneAfterCreation({
    createdProduct,
    isLabTest,
    parsedName,
    record,
    consumables,
  });

  return createdProduct;
}

// Helper function to create payment for products (used in visits)
export const createPaymentForProducts = async (
  productIds: number[],
  visitId: number,
  paymentType: PaymentType,
  options?: boolean | { allowPartial?: boolean; tx?: Prisma.TransactionClient }
) => {
  const allowPartial =
    typeof options === "boolean" ? options : options?.allowPartial;
  const txClient = typeof options === "object" ? (options?.tx ?? db) : db;

  type SimpleProductForPayment = ProductForPayment;
  type SimpleVisitForPayment = VisitForPayment;

  const addInsurancePaymentDetailInner = ({
    details,
    product: insuranceProduct,
    visit: insuranceVisit,
    targetClinicId,
  }: {
    details: PaymentDetail[];
    product: SimpleProductForPayment;
    visit: SimpleVisitForPayment;
    targetClinicId: number;
  }) => {
    const insuranceCompanyName =
      insuranceVisit.patientInsurance?.insuranceCompany?.companyName;
    if (!insuranceCompanyName) {
      throw new Error("Insurance company not found in visit");
    }

    // Try to find clinic-specific insurance price first
    let insurancePrice = insuranceProduct.insurancePrices.find(
      (ip) =>
        ip.insuranceCompany.companyName === insuranceCompanyName &&
        ip.clinicId === targetClinicId
    );

    // Fallback to global insurance price (clinicId is null or undefined)
    if (!insurancePrice) {
      insurancePrice = insuranceProduct.insurancePrices.find(
        (ip) =>
          ip.insuranceCompany.companyName === insuranceCompanyName &&
          (ip.clinicId === null || ip.clinicId === undefined)
      );
    }

    if (!insurancePrice) {
      throw new Error(
        `Insurance price not defined for product: ${insuranceProduct.name}`
      );
    }

    const productPrice = Number(insurancePrice.price);
    const coveragePercent =
      Number(insuranceVisit.patientInsurance?.coveragePercentage) / 100;
    const productInsuranceAmount = productPrice * coveragePercent;
    const productPatientAmount = productPrice * (1 - coveragePercent);

    details.push({
      productName: insuranceProduct.name,
      amount: productPrice,
      patientAmount: productPatientAmount,
      insuranceAmount: productInsuranceAmount,
      productId: insuranceProduct.id,
      quantity: 1,
    });

    return {
      amount: productPrice,
      patientAmount: productPatientAmount,
      insuranceAmount: productInsuranceAmount,
    };
  };

  const addCashPaymentDetailInner = async ({
    details,
    product: cashProduct,
    visit: cashVisit,
    targetClinicId,
  }: {
    details: PaymentDetail[];
    product: SimpleProductForPayment;
    visit: SimpleVisitForPayment;
    targetClinicId: number;
  }) => {
    const isRwandan =
      cashVisit.patient.nationality === "Rwanda" &&
      !cashVisit.patient.isAForeigner;
    const region = cashVisit.patient.foreignerRegion;
    let effectivePrice = 0;
    if (region === "EAST_AFRICA") {
      effectivePrice = Number(cashProduct.eastAfricaPrice);
    } else if (region === "AFRICA") {
      effectivePrice = Number(cashProduct.africaPrice);
    } else {
      effectivePrice = Number(cashProduct.restOfWorldPrice);
    }

    // Get clinic-specific prices with fallback
    const clinicPrices = await getClinicProductPrice(
      cashProduct.id,
      targetClinicId
    );

    const basePrice = isRwandan
      ? Number(clinicPrices.basePrice ?? cashProduct.basePrice)
      : effectivePrice;

    details.push({
      productName: cashProduct.name,
      amount: basePrice,
      patientAmount: basePrice,
      insuranceAmount: 0,
      productId: cashProduct.id,
      quantity: 1,
    });

    return {
      amount: basePrice,
      patientAmount: basePrice,
      insuranceAmount: 0,
    };
  };
  // First get the visit to know the clinicId
  const visitForClinic = await txClient.visit.findUnique({
    where: {
      id: visitId,
    },
    select: {
      clinicId: true,
    },
  });

  if (!visitForClinic) {
    throw new Error("Visit not found");
  }

  const clinicId = visitForClinic.clinicId;

  const products = await txClient.product.findMany({
    where: {
      id: {
        in: productIds,
      },
    },
    select: {
      id: true,
      name: true,
      basePrice: true,
      eastAfricaPrice: true,
      africaPrice: true,
      restOfWorldPrice: true,
      insurancePrices: {
        where: {
          OR: [{ clinicId }, { clinicId: null }],
        },
        select: {
          price: true,
          clinicId: true,
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

  const visit = await txClient.visit.findUnique({
    where: {
      id: visitId,
    },
    select: {
      id: true,
      paymentMode: true,
      clinicId: true,
      branchId: true,
      patient: {
        select: {
          nationality: true,
          isAForeigner: true,
          foreignerRegion: true,
        },
      },
      patientInsurance: {
        select: {
          coveragePercentage: true,
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

  if (!visit) {
    throw new Error("Visit not found");
  }

  let amount = 0;
  let patientAmount = 0;
  let insuranceAmount = 0;
  const paymentDetails: PaymentDetail[] = [];

  for (const productItem of products as SimpleProductForPayment[]) {
    if (visit.paymentMode === PaymentMode.INSURANCE) {
      const d = addInsurancePaymentDetailInner({
        details: paymentDetails,
        product: productItem,
        visit: visit as SimpleVisitForPayment,
        targetClinicId: clinicId,
      });
      amount += d.amount;
      insuranceAmount += d.insuranceAmount;
      patientAmount += d.patientAmount;
      continue;
    }

    const d = await addCashPaymentDetailInner({
      details: paymentDetails,
      product: productItem,
      visit: visit as SimpleVisitForPayment,
      targetClinicId: clinicId,
    });
    amount += Number(d.amount);
    patientAmount += Number(d.patientAmount);
  }

  if (amount === 0) {
    throw new Error("Amount is 0");
  }

  const payment = await txClient.payment.create({
    data: {
      clinic: {
        connect: {
          id: visit.clinicId,
        },
      },
      branch: {
        connect: visit.branchId
          ? {
              id: visit.branchId,
            }
          : undefined,
      },
      visit: {
        connect: {
          id: visit.id,
        },
      },
      paymentMode: visit.paymentMode as PaymentMode,
      products: {
        connect: products.map((product: { id: number }) => ({
          id: product.id,
        })),
      },
      paymentStatus: PaymentStatus.PENDING,
      paymentDetails,
      paymentType,
      amount,
      patientAmount,
      insuranceAmount,
      allowPartial,
    },
  });

  return payment;
};

export function getTargetClinicId(
  user: { role: Role; clinicId: number },
  clinicIdFromScope: number | undefined
): number | undefined {
  if (typeof clinicIdFromScope === "number") {
    return clinicIdFromScope;
  }
  if (user.role !== Role.SUPER_ADMIN) {
    return user.clinicId;
  }
  return;
}
