import {
  ItemType,
  PaymentMode,
  PaymentStatus,
  type PaymentType,
  PriceType,
  Unit,
} from "../../generated/prisma";
import { db } from "../database/db";
import { logger } from "../lib/logger";

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
  FOREIGNERS_TARIFF?: string;
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
  foreignersPrice: unknown;
  insurancePrices: {
    price: unknown;
    insuranceCompany: { companyName: string };
  }[];
};
type VisitForPayment = {
  paymentMode: PaymentMode;
  patient: { nationality: string; isAForeigner: boolean };
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
  foreignersPrice: number;
  insurancePrices: {
    id: number;
    price: number;
    priceWithCo?: number;
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

// Insurance company constants (matching original)
const InsuranceCompanies = ["RSSB", "MUTUELLE DE SANTE", "PRIVATE INSURANCE"];

const SpecialInsurers = ["GOVERNMENT", "MILITARY"];

// Regex pattern for lab test parsing (defined at top level for performance)
const LAB_TEST_REGEX = /^\((\d+)\)(.+)$/;

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

// Helper function to get insurance company ID
async function getInsuranceCompanyId(companyName: string) {
  const insuranceCompany = await db.insuranceCompany.findUnique({
    where: { companyName },
    select: { id: true },
  });
  if (!insuranceCompany) {
    throw new Error("Insurance company not found");
  }
  return insuranceCompany.id;
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

// Main helper function to find existing product
export async function findExistingProduct(
  name: string
): Promise<IExistingProduct | null> {
  const product = await db.product.findFirst({
    where: { name },
    select: {
      id: true,
      name: true,
      category: true,
      insurancePrices: {
        select: {
          id: true,
          price: true,
          priceWithCo: true,
          insuranceCompany: { select: { companyName: true } },
        },
      },
      unit: true,
      normalRange: true,
      basePrice: true,
      foreignersPrice: true,
      consumables: true,
      clinics: { select: { id: true } },
    },
  });

  if (!product) {
    return null;
  }

  return {
    ...product,
    basePrice: Number(product.basePrice) || 0,
    foreignersPrice: Number(product.foreignersPrice) || 0,
    unit: product.unit || undefined,
    normalRange: product.normalRange || undefined,
    consumables:
      (product.consumables as { name: string; quantity: string }[] | null) ||
      undefined,
    insurancePrices: product.insurancePrices.map((ip) => ({
      ...ip,
      price: Number(ip.price),
      priceWithCo: ip.priceWithCo ? Number(ip.priceWithCo) : undefined,
    })),
  };
}

// Helper function to create new insurance price
export const createNewInsurancePrice = async ({
  productId,
  price,
  insuranceCompanyName,
  priceType,
  priceWithCo,
}: {
  productId: number;
  price: number;
  insuranceCompanyName: string;
  priceType: PriceType;
  priceWithCo?: number;
}) => {
  return db.insurancePrice.create({
    data: {
      productId,
      price,
      priceWithCo,
      insuranceCompanyId: await getInsuranceCompanyId(insuranceCompanyName),
      priceType,
    },
  });
};

// Helper functions to reduce complexity
const updateInsurancePrice = async ({
  existingProduct,
  price,
  companies,
  priceType,
  field,
}: {
  existingProduct: IExistingProduct;
  price: number;
  companies: string[];
  priceType: PriceType;
  field: "price" | "priceWithCo";
}) => {
  for (const companyName of companies) {
    const existingPrice = existingProduct.insurancePrices.find(
      (ip) => ip.insuranceCompany.companyName === companyName
    );
    if (existingPrice) {
      await db.insurancePrice.update({
        where: { id: existingPrice.id },
        data: { [field]: price },
      });
    } else {
      await createNewInsurancePrice({
        productId: existingProduct.id,
        price: field === "price" ? price : 0,
        insuranceCompanyName: companyName,
        priceType,
        priceWithCo: field === "priceWithCo" ? price : undefined,
      });
    }
  }
};

const updateProductPricing = async (
  productId: number,
  newPrivateTariff: number,
  newForeignersTariff: number
) => {
  if (!Number.isNaN(newPrivateTariff)) {
    await db.product.update({
      where: { id: productId },
      data: { basePrice: newPrivateTariff },
    });
  }
  if (!Number.isNaN(newForeignersTariff)) {
    await db.product.update({
      where: { id: productId },
      data: { foreignersPrice: newForeignersTariff },
    });
  }
};

// Connect product to clinic if missing
async function connectProductToClinic(
  existingProduct: IExistingProduct,
  clinicId: number
) {
  const clinicIds = existingProduct.clinics.map((c) => c.id);
  if (!clinicIds.includes(clinicId)) {
    await db.product.update({
      where: { id: existingProduct.id },
      data: {
        clinics: {
          connect: { id: clinicId },
        },
      },
    });
  }
}

// Apply insurance updates in one place to reduce complexity at call site
async function applyInsuranceUpdates(
  existingProduct: IExistingProduct,
  newTariff: number,
  newGovTariff: number,
  newTariffWithCo: number
) {
  if (!Number.isNaN(newTariff)) {
    await updateInsurancePrice({
      existingProduct,
      price: newTariff,
      companies: InsuranceCompanies,
      priceType: PriceType.PRIVATE,
      field: "price",
    });
  }
  if (!Number.isNaN(newGovTariff)) {
    await updateInsurancePrice({
      existingProduct,
      price: newGovTariff,
      companies: SpecialInsurers,
      priceType: PriceType.GOV,
      field: "price",
    });
  }
  if (!Number.isNaN(newTariffWithCo)) {
    await updateInsurancePrice({
      existingProduct,
      price: newTariffWithCo,
      companies: InsuranceCompanies,
      priceType: PriceType.PRIVATE,
      field: "priceWithCo",
    });
  }
}

// Update non-lab product fields
async function updateNonLabFields(
  productId: number,
  newUnit?: string,
  newNormalRange?: string,
  newConsumables?: { name: string; quantity: string }[]
) {
  if (newUnit) {
    await db.product.update({
      where: { id: productId },
      data: { unit: newUnit },
    });
  }
  if (newNormalRange) {
    await db.product.update({
      where: { id: productId },
      data: { normalRange: newNormalRange },
    });
  }
  if (Array.isArray(newConsumables) && newConsumables.length > 0) {
    await db.product.update({
      where: { id: productId },
      data: { consumables: newConsumables },
    });
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
    const hasChildren = await isParentProduct(record.NAME);
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
  clinicId: number
) {
  await connectProductToClinic(existingProduct, clinicId);

  const newTariff = Number.parseFloat(record.TARIFF);
  const newGovTariff = Number.parseFloat(record.GOV_INSURANCE as string);
  const newTariffWithCo = Number.parseFloat(record.TARIFF_WITH_CO as string);
  const newPrivateTariff = Number.parseFloat(record.PRIVATE_TARIFF as string);
  const newForeignersTariff = Number.parseFloat(
    record.FOREIGNERS_TARIFF as string
  );
  const newUnit = record.UNIT;
  const newNormalRange = record.NORMAL_RANGE;

  let newConsumables: { name: string; quantity: string }[] = [];
  if (record.CONSUMABLES) {
    newConsumables = record.CONSUMABLES.split(",").map((item) => {
      const [name, quantity] = item.split("(");
      return { name: name.trim(), quantity: quantity.trim().replace(")", "") };
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

  // Handle insurance prices
  await applyInsuranceUpdates(
    existingProduct,
    newTariff,
    newGovTariff,
    newTariffWithCo
  );

  // Update product pricing
  await updateProductPricing(
    existingProduct.id,
    newPrivateTariff,
    newForeignersTariff
  );

  // Handle lab test specific logic
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
    await updateNonLabFields(
      existingProduct.id,
      newUnit,
      newNormalRange,
      newConsumables
    );
  }

  // Handle departments
  if (newDepartments.length > 0) {
    await db.product.update({
      where: { id: existingProduct.id },
      data: {
        departments: {
          connectOrCreate: newDepartments.map((department) => ({
            where: { name: department },
            create: { name: department },
          })),
        },
      },
    });
  }
}

// Small helpers to reduce complexity in createNewProduct
function parseConsumablesFromRecord(record: ProductCSVRow) {
  if (!record.CONSUMABLES) {
    return [] as { name: string; quantity: string }[];
  }
  return record.CONSUMABLES.split(",").map((item) => {
    const [name, quantity] = item.split("(");
    return { name: name.trim(), quantity: quantity.replace(")", "") };
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
      basePrice: record.PRIVATE_TARIFF || undefined,
      consumables: isLabTest ? undefined : consumables,
      unit: record.UNIT || undefined,
      normalRange: record.NORMAL_RANGE || undefined,
      foreignersPrice: record.FOREIGNERS_TARIFF || undefined,
    },
    select: { id: true, name: true },
  });

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
  paymentType: PaymentType
) => {
  type SimpleProductForPayment = ProductForPayment;
  type SimpleVisitForPayment = VisitForPayment;

  const addInsurancePaymentDetailInner = ({
    details,
    product: insuranceProduct,
    visit: insuranceVisit,
  }: {
    details: PaymentDetail[];
    product: SimpleProductForPayment;
    visit: SimpleVisitForPayment;
  }) => {
    const insurancePrice = insuranceProduct.insurancePrices.find(
      (ip) =>
        ip.insuranceCompany.companyName ===
        insuranceVisit.patientInsurance?.insuranceCompany?.companyName
    );
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

  const addCashPaymentDetailInner = ({
    details,
    product: cashProduct,
    visit: cashVisit,
  }: {
    details: PaymentDetail[];
    product: SimpleProductForPayment;
    visit: SimpleVisitForPayment;
  }) => {
    const isRwandan =
      cashVisit.patient.nationality === "Rwanda" &&
      !cashVisit.patient.isAForeigner;
    const basePrice = isRwandan
      ? Number(cashProduct.basePrice)
      : Number(cashProduct.foreignersPrice);

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
  const products = await db.product.findMany({
    where: {
      id: {
        in: productIds,
      },
    },
    select: {
      id: true,
      name: true,
      basePrice: true,
      foreignersPrice: true,
      insurancePrices: {
        select: {
          price: true,
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

  const visit = await db.visit.findUnique({
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
      });
      amount += d.amount;
      insuranceAmount += d.insuranceAmount;
      patientAmount += d.patientAmount;
      continue;
    }
    if (!productItem.basePrice) {
      throw new Error(
        `Base price not defined for product: ${productItem.name}`
      );
    }
    const d = addCashPaymentDetailInner({
      details: paymentDetails,
      product: productItem,
      visit: visit as SimpleVisitForPayment,
    });
    amount += d.amount;
    patientAmount += d.patientAmount;
  }

  if (amount === 0) {
    throw new Error("Amount is 0");
  }

  const payment = await db.payment.create({
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
        connect: products.map((product) => ({ id: product.id })),
      },
      paymentStatus: PaymentStatus.PENDING,
      paymentDetails,
      paymentType,
      amount,
      patientAmount,
      insuranceAmount,
    },
  });

  return payment;
};
