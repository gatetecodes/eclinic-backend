import { Decimal } from "generated/prisma/internal/prismaNamespace";
import { AppError } from "@/lib/app-error";
import { httpCodes } from "@/lib/constants";
import { logger } from "@/lib/logger";
import type { Prisma } from "../../generated/prisma/client";
import {
  InventoryStatus,
  type ItemType,
  PaymentMode,
  PaymentStatus,
  type PaymentType,
  SourceType,
  TransactionStatus,
  TransactionType,
  type Unit,
} from "../../generated/prisma/client";
import { db } from "../database/db";
import type {
  ConsumableCSVRow,
  IExistingInventoryItem,
  IPaymentDetail,
  ITreatment,
} from "../types/inventory-types";

export async function findExistingInventoryItem(
  name: string,
  clinicId: number,
  branchId: number
) {
  return await db.inventoryItem.findFirst({
    where: { itemName: name, clinicId, branchId },
    select: {
      id: true,
      itemName: true,
      sku: true,
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
  const maybePrice = Number.parseFloat(record.PRICE);

  const newReorderLevel = record.REORDER_LEVEL
    ? Number.parseInt(record.REORDER_LEVEL, 10)
    : existingItem.reorderLevel;

  const data: Record<string, unknown> = {
    reorderLevel: newReorderLevel,
  };

  if (!existingItem.sku) {
    data.sku = generateSku(existingItem.itemName);
  }

  if (Number.isFinite(maybePrice)) {
    data.unitPrice = maybePrice;
  }

  if (record.UNIT) {
    data.unit = record.UNIT as Unit;
  }

  const updatedItem = await db.inventoryItem.update({
    where: { id: existingItem.id },
    data,
  });

  // Refresh status after reorder level or other potential changes
  await db.$transaction(async (tx) => {
    await refreshItemStatus(tx as Prisma.TransactionClient, existingItem.id);
  });

  return updatedItem;
};

export async function createNewInventoryItem(
  record: ConsumableCSVRow,
  clinicId: number,
  branchId: number
) {
  return await db.inventoryItem.create({
    data: {
      itemName: record.NAME,
      sku: generateSku(record.NAME),
      itemType: record.CATEGORY as ItemType,
      clinicId,
      branchId,
      unitPrice: record.PRICE,
      reorderLevel: record.REORDER_LEVEL
        ? Number.parseInt(record.REORDER_LEVEL, 10)
        : 0,
      unit: record.UNIT as Unit,
      status: InventoryStatus.OUT_OF_STOCK,
      currentStock: {
        create: {
          quantity: 0,
        },
      },
    },
  });
}

export async function getValidatedBatch(
  tx: Prisma.TransactionClient,
  batchId: number,
  itemId: number,
  requiredQty: number
) {
  const batch = await tx.inventoryBatch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      itemId: true,
      currentQuantity: true,
      unitPrice: true,
    },
  });
  if (!batch || batch.itemId !== itemId) {
    throw new AppError({
      status: httpCodes.NOT_FOUND,
      code: "BATCH_NOT_FOUND",
      message: `Batch not found or mismatched for item: ${batchId}`,
      exposeMessage: true,
    });
  }
  if (batch.currentQuantity < requiredQty) {
    throw new AppError({
      status: httpCodes.BAD_REQUEST,
      code: "INSUFFICIENT_STOCK",
      message: `Insufficient stock in batch: ${batchId}`,
      exposeMessage: true,
    });
  }
  return batch;
}

export async function createNegativeStockTransaction(
  tx: Prisma.TransactionClient,
  args: {
    itemId: number;
    batchId: number;
    quantity: number;
    unitPrice: Decimal | string | number | null;
    type?: TransactionType;
    sourceType?: SourceType;
    visitId?: number;
    userId?: number;
    dispenseOrderId?: string;
  }
): Promise<number> {
  if (!args.userId) {
    throw new AppError({
      status: httpCodes.BAD_REQUEST,
      code: "USER_ID_REQUIRED",
      message: "User ID is required to record inventory transactions",
      exposeMessage: true,
    });
  }
  const row = await tx.transaction.create({
    data: {
      itemId: args.itemId,
      batchId: args.batchId,
      type: args.type ?? TransactionType.SALE,
      quantity: -Number(args.quantity),
      unitPrice: args.unitPrice ? new Decimal(args.unitPrice) : null,
      totalAmount: args.unitPrice
        ? new Decimal(args.unitPrice).mul(Number(args.quantity))
        : null,
      sourceType: args.sourceType ?? SourceType.VISIT,
      visitId: args.visitId,
      dispenseOrderId: args.dispenseOrderId,
      userId: args.userId,
      status: TransactionStatus.COMPLETED,
    },
    select: { id: true },
  });
  return row.id;
}

async function decrementBatchAndStock(
  tx: Prisma.TransactionClient,
  batchId: number,
  itemId: number,
  quantity: number
) {
  await tx.inventoryBatch.update({
    where: { id: batchId },
    data: { currentQuantity: { decrement: Number(quantity) } },
  });
  await tx.inventoryStock.update({
    where: { itemId },
    data: { quantity: { decrement: Number(quantity) } },
  });
  await refreshItemStatus(tx, itemId);
}

export async function refreshItemStatus(
  tx: Prisma.TransactionClient,
  itemId: number
) {
  const item = await tx.inventoryItem.findUnique({
    where: { id: itemId },
    include: { currentStock: true },
  });
  if (!item?.currentStock) {
    return;
  }
  const currentQty = item.currentStock.quantity ?? 0;
  let newStatus: InventoryStatus = InventoryStatus.IN_STOCK;
  if (currentQty === 0) {
    newStatus = InventoryStatus.OUT_OF_STOCK;
  } else if (currentQty <= item.reorderLevel) {
    newStatus = InventoryStatus.LOW_STOCK;
  }
  if (newStatus !== item.status) {
    await tx.inventoryItem.update({
      where: { id: itemId },
      data: { status: newStatus },
    });
  }
}

export function generateReceiptBatchNumber(itemId: number): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `GRN-${itemId}-${yyyy}${mm}${dd}-${rand}`;
}

function assertPositiveInventoryQuantity(quantity: number) {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new AppError({
      status: httpCodes.BAD_REQUEST,
      code: "INVALID_QUANTITY",
      message: "Quantity must be greater than zero",
      exposeMessage: true,
    });
  }
}

/**
 * Receives a single goods-receipt line into stock: creates a batch, records a
 * PURCHASE transaction, increments aggregate stock and refreshes item status.
 * Shared by ad-hoc goods receipt and purchase-order receiving so both paths
 * behave identically while preserving the correct source type.
 */
export async function applyGoodsReceiptLine(
  tx: Prisma.TransactionClient,
  line: {
    itemId: number;
    quantity: number;
    unitPrice?: number | string | Decimal | null;
    batchNumber?: string | null;
    expiryDate?: Date | null;
    location?: string | null;
  },
  ctx: {
    userId: number;
    branchId?: number | null;
    notes?: string | null;
    sourceType: SourceType;
  }
): Promise<{ batchId: number }> {
  assertPositiveInventoryQuantity(line.quantity);
  const unitPrice = line.unitPrice != null ? new Decimal(line.unitPrice) : null;
  const batch = await tx.inventoryBatch.create({
    data: {
      itemId: line.itemId,
      batchNumber: line.batchNumber || generateReceiptBatchNumber(line.itemId),
      expiryDate: line.expiryDate ?? null,
      initialQuantity: line.quantity,
      currentQuantity: line.quantity,
      unitPrice,
      location: line.location ?? "RECEIVING",
      branchId: ctx.branchId ?? null,
    },
    select: { id: true },
  });
  await tx.transaction.create({
    data: {
      itemId: line.itemId,
      batchId: batch.id,
      type: TransactionType.PURCHASE,
      quantity: line.quantity,
      unitPrice,
      totalAmount: unitPrice ? unitPrice.mul(line.quantity) : null,
      sourceType: ctx.sourceType,
      notes: ctx.notes ?? null,
      userId: ctx.userId,
      status: TransactionStatus.COMPLETED,
    },
  });
  await tx.inventoryStock.upsert({
    where: { itemId: line.itemId },
    create: { itemId: line.itemId, quantity: line.quantity },
    update: { quantity: { increment: line.quantity } },
  });
  await refreshItemStatus(tx, line.itemId);
  return { batchId: batch.id };
}

/**
 * Seed an item's opening stock as a proper batch + ADJUSTMENT ledger entry so
 * FEFO, valuation and stock-out stay consistent. Assumes the item's aggregate
 * stock has already been set to `quantity`; this only adds the batch/ledger.
 */
export async function seedOpeningStock(
  tx: Prisma.TransactionClient,
  input: {
    itemId: number;
    quantity: number;
    unitPrice?: number | string | Decimal | null;
    branchId?: number | null;
    userId: number;
  }
) {
  assertPositiveInventoryQuantity(input.quantity);
  const unitPrice =
    input.unitPrice != null ? new Decimal(input.unitPrice) : null;
  const batch = await tx.inventoryBatch.create({
    data: {
      itemId: input.itemId,
      batchNumber: `OPENING-${input.itemId}-${Date.now().toString(36).toUpperCase()}`,
      initialQuantity: input.quantity,
      currentQuantity: input.quantity,
      unitPrice,
      location: "OPENING",
      branchId: input.branchId ?? null,
    },
    select: { id: true },
  });
  await tx.transaction.create({
    data: {
      itemId: input.itemId,
      batchId: batch.id,
      type: TransactionType.ADJUSTMENT,
      quantity: input.quantity,
      unitPrice,
      totalAmount: unitPrice ? unitPrice.mul(input.quantity) : null,
      sourceType: SourceType.MANUAL,
      notes: "Opening stock",
      userId: input.userId,
      status: TransactionStatus.COMPLETED,
    },
  });
  await refreshItemStatus(tx, input.itemId);
}

export function generateSku(itemName: string): string {
  const prefix = itemName
    .substring(0, 3)
    .toUpperCase()
    .replace(/[^A-Z]/g, "X")
    .padEnd(3, "X");
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  const timestamp = Date.now().toString(36).slice(-4).toUpperCase();
  return `SKU-${prefix}-${random}${timestamp}`;
}

export const performStockOut = async (
  selectedBatches: { id: number; quantity: number; itemId: number }[],
  options?: {
    userId?: number;
    visitId?: number;
    type?: TransactionType;
    sourceType?: SourceType;
    dispenseOrderId?: string;
  }
) => {
  return await db.$transaction(async (tx) => {
    for (const { id, quantity, itemId } of selectedBatches) {
      const batch = await getValidatedBatch(tx, id, itemId, quantity);
      await createNegativeStockTransaction(tx, {
        itemId,
        batchId: id,
        quantity,
        unitPrice: batch.unitPrice,
        type: options?.type,
        sourceType: options?.sourceType,
        visitId: options?.visitId,
        userId: options?.userId,
        dispenseOrderId: options?.dispenseOrderId,
      });
      await decrementBatchAndStock(tx, id, itemId, quantity);
    }
  });
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
      currentQuantity: { gt: 0 },
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
    return { patientAmount: Number(totalPrice.toFixed(2)), insuranceAmount: 0 };
  }

  const coverageDecimal = coveragePercentage / 100;
  const insuranceAmount = Number((totalPrice * coverageDecimal).toFixed(2));
  const patientAmount = Number((totalPrice - insuranceAmount).toFixed(2));

  return {
    insuranceAmount,
    patientAmount,
  };
}

export const createPaymentForInventoryItems = async (
  treatments: ITreatment[],
  visitId: number,
  paymentType: PaymentType,
  options?: { allowPartial?: boolean; userId?: number }
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
  const selectedBatches: { id: number; quantity: number; itemId: number }[] =
    [];

  for (const treatment of treatments) {
    const item = items.find((i) => i.id === +treatment.id);
    if (!item) {
      throw new Error(`Item not found: ${treatment.id}`);
    }
    const batch = batches.find((b) => b.itemId === +treatment.id);
    if (!batch) {
      throw new Error(`No valid batch found for item: ${item.itemName}`);
    }
    selectedBatches.push({
      id: batch.id,
      quantity: treatment.quantity,
      itemId: item.id,
    });

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

  await performStockOut(selectedBatches, {
    userId: options?.userId,
    visitId,
    type: TransactionType.SALE,
    sourceType: SourceType.VISIT,
  });

  return db.payment.create({
    data: {
      clinic: { connect: { id: visit.clinicId } },
      visit: { connect: { id: visit.id } },
      paymentMode: visit.paymentMode as PaymentMode,
      paymentStatus: PaymentStatus.PENDING,
      paymentDetails: JSON.parse(JSON.stringify(paymentDetails)),
      paymentType,
      amount: Number(totalAmount.toFixed(2)),
      patientAmount: Number(totalPatientAmount.toFixed(2)),
      insuranceAmount: Number(totalInsuranceAmount.toFixed(2)),
      allowPartial: options?.allowPartial ?? false,
    },
  });
};

export function processInventoryItemRecord(clinicId: number, branchId: number) {
  return async (record: ConsumableCSVRow) => {
    try {
      const existingItem = await findExistingInventoryItem(
        record.NAME,
        clinicId,
        branchId
      );
      if (existingItem) {
        return handleExistingInventoryItem(existingItem, record);
      }
      return createNewInventoryItem(record, clinicId, branchId);
    } catch (error) {
      logger.error(`Error processing inventory item ${record.NAME}:`, {
        error,
      });
      return null;
    }
  };
}
