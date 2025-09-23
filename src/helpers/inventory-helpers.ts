import { logger } from "@/lib/logger";
import {
  type ItemType,
  PaymentMode,
  PaymentStatus,
  type PaymentType,
  type Unit,
} from "../../generated/prisma";
import { db } from "../database/db";
import type {
  ConsumableCSVRow,
  IExistingInventoryItem,
  IPaymentDetail,
  ITreatment,
} from "../types/inventory-types";

export async function findExistingInventoryItem(
  name: string,
  clinicId: number
) {
  return await db.inventoryItem.findFirst({
    where: { itemName: name, clinicId },
    select: {
      id: true,
      itemName: true,
      itemType: true,
      reorderLevel: true,
      unit: true,
    },
  });
}

export const handleExistingInventoryItem = async (
  existingItem: IExistingInventoryItem,
  record: ConsumableCSVRow
) => {
  const newUnitPrice = Number.parseFloat(record.PRICE);
  const newUnit = record.UNIT as Unit;
  const newReorderLevel = record.REORDER_LEVEL
    ? Number.parseInt(record.REORDER_LEVEL, 10)
    : existingItem.reorderLevel;

  return await db.inventoryItem.update({
    where: { id: existingItem.id },
    data: {
      unitPrice: newUnitPrice,
      unit: newUnit,
      reorderLevel: newReorderLevel,
    },
  });
};

export async function createNewInventoryItem(
  record: ConsumableCSVRow,
  clinicId: number
) {
  return await db.inventoryItem.create({
    data: {
      itemName: record.NAME,
      itemType: record.CATEGORY as ItemType,
      clinicId,
      unitPrice: record.PRICE,
      reorderLevel: record.REORDER_LEVEL
        ? Number.parseInt(record.REORDER_LEVEL, 10)
        : 0,
      unit: record.UNIT as Unit,
    },
  });
}

export const performStockOut = async (
  selectedBatches: { id: number; quantity: number }[]
) => {
  for (const selectedBatch of selectedBatches) {
    const batch = await db.inventoryBatch.findUnique({
      where: { id: selectedBatch.id },
    });
    if (!batch) {
      throw new Error(`Batch not found: ${selectedBatch.id}`);
    }
    await db.inventoryBatch.update({
      where: { id: selectedBatch.id },
      data: { currentQuantity: { decrement: selectedBatch.quantity } },
    });
  }
};

async function fetchInventoryItems(treatmentIds: number[]) {
  return await db.inventoryItem.findMany({
    where: {
      id: { in: treatmentIds },
    },
    select: {
      id: true,
      itemName: true,
      unitPrice: true,
    },
  });
}

async function fetchValidBatches(treatmentIds: number[]) {
  return await db.inventoryBatch.findMany({
    where: {
      itemId: { in: treatmentIds },
      OR: [{ expiryDate: null }, { expiryDate: { gt: new Date() } }],
    },
    orderBy: { expiryDate: "asc" },
    select: {
      id: true,
      batchNumber: true,
      expiryDate: true,
      initialQuantity: true,
      currentQuantity: true,
      unitPrice: true,
      itemId: true,
    },
  });
}

function calculatePaymentAmounts(
  totalPrice: number,
  coveragePercentage: number | null = null
): { patientAmount: number; insuranceAmount: number } {
  if (!coveragePercentage) {
    return { patientAmount: totalPrice, insuranceAmount: 0 };
  }

  const coverageDecimal = coveragePercentage / 100;
  return {
    insuranceAmount: totalPrice * coverageDecimal,
    patientAmount: totalPrice * (1 - coverageDecimal),
  };
}

export const createPaymentForInventoryItems = async (
  treatments: ITreatment[],
  visitId: number,
  paymentType: PaymentType
) => {
  // Convert treatment IDs to numbers once
  const treatmentIds = treatments.map((t) => +t.id);

  // Parallel fetch of items and batches for better performance
  const [items, batches, visit] = await Promise.all([
    fetchInventoryItems(treatmentIds),
    fetchValidBatches(treatmentIds),
    db.visit.findUnique({
      where: { id: visitId },
      select: {
        id: true,
        paymentMode: true,
        clinicId: true,
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
    }),
  ]);

  if (!visit) {
    throw new Error("Visit not found");
  }

  let totalAmount = 0;
  let totalPatientAmount = 0;
  let totalInsuranceAmount = 0;
  const paymentDetails: IPaymentDetail[] = [];

  for (const treatment of treatments) {
    const item = items.find((i) => i.id === +treatment.id);
    if (!item) {
      throw new Error(`Item not found: ${treatment.id}`);
    }

    const batch = batches.find((b) => b.itemId === +treatment.id);
    if (!batch) {
      throw new Error(`No valid batch found for item: ${item.itemName}`);
    }

    const unitPrice = batch.unitPrice ?? item.unitPrice;
    if (!unitPrice) {
      throw new Error(`No unit price found for item: ${item.itemName}`);
    }

    const totalPrice = Number(unitPrice) * treatment.quantity;
    const { patientAmount, insuranceAmount } = calculatePaymentAmounts(
      totalPrice,
      visit.paymentMode === PaymentMode.INSURANCE
        ? Number(visit.patientInsurance?.coveragePercentage)
        : null
    );

    paymentDetails.push({
      productName: item.itemName,
      amount: totalPrice,
      patientAmount,
      insuranceAmount,
      productId: item.id,
      quantity: treatment.quantity,
      batchId: batch.id,
    });

    totalAmount += totalPrice;
    totalInsuranceAmount += insuranceAmount;
    totalPatientAmount += patientAmount;
  }

  if (totalAmount === 0) {
    throw new Error("Amount is 0");
  }

  await performStockOut(
    batches.map((batch) => ({
      id: batch.id,
      quantity:
        treatments.find((t) => t.id === batch.itemId.toString())?.quantity || 0,
    }))
  );

  return db.payment.create({
    data: {
      clinic: { connect: { id: visit.clinicId } },
      visit: { connect: { id: visit.id } },
      paymentMode: visit.paymentMode as PaymentMode,
      paymentStatus: PaymentStatus.PENDING,
      paymentDetails: JSON.parse(JSON.stringify(paymentDetails)),
      paymentType,
      amount: totalAmount,
      patientAmount: totalPatientAmount,
      insuranceAmount: totalInsuranceAmount,
    },
  });
};

export function processInventoryItemRecord(clinicId: number) {
  return async (record: ConsumableCSVRow) => {
    try {
      const existingItem = await findExistingInventoryItem(
        record.NAME,
        clinicId
      );
      if (existingItem) {
        return handleExistingInventoryItem(existingItem, record);
      }
      return createNewInventoryItem(record, clinicId);
    } catch (error) {
      logger.error(`Error processing inventory item ${record.NAME}:`, {
        error,
      });
      return null;
    }
  };
}
