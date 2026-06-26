import { randomUUID } from "node:crypto";
import {
  createNegativeStockTransaction,
  getValidatedBatch,
  refreshItemStatus,
} from "@/helpers/inventory-helpers";
import { AppError } from "@/lib/app-error";
import { httpCodes } from "@/lib/constants";
import type { Prisma } from "../../generated/prisma/client";
import {
  CareStage,
  PrescriptionItemFulfilment,
  PrescriptionStatus,
  SourceType,
  TransactionType,
  VisitStatus,
} from "../../generated/prisma/client";
import type {
  DispenseLineInput,
  ExecuteDispenseParams,
} from "../types/pharmacy-dispense.types.ts";

/**
 * A visit that was automatically completed as a side-effect of dispensing the
 * last clinic-stock line of its prescription. Returned up the call stack so the
 * controller can fire the same best-effort side-effects (queue served, cache
 * invalidation, live flow event) the manual `/advance` endpoint does.
 */
export type AutoCompletedVisit = {
  id: number;
  clinicId: number;
  branchId: number | null;
  patientId: number;
  doctorId: number | null;
};

export const PHARMACY_ORDER_INCLUDE = {
  lines: {
    include: {
      inventoryItem: { select: { id: true, itemName: true } },
      batch: { select: { id: true, batchNumber: true } },
      transaction: { select: { id: true } },
    },
  },
  prescription: {
    select: { id: true, visitId: true, status: true },
  },
} as const;

async function findFefoBatch(
  tx: Prisma.TransactionClient,
  itemId: number,
  quantity: number,
  branchId: number | undefined
) {
  const batches = await tx.inventoryBatch.findMany({
    where: {
      itemId,
      currentQuantity: { gte: quantity },
      OR: [{ expiryDate: null }, { expiryDate: { gt: new Date() } }],
      ...(typeof branchId === "number" ? { branchId } : {}),
    },
    orderBy: [{ expiryDate: "asc" }, { id: "asc" }],
    select: {
      id: true,
      itemId: true,
      currentQuantity: true,
      unitPrice: true,
    },
  });
  const batch = batches[0];
  if (!batch) {
    throw new AppError({
      status: httpCodes.BAD_REQUEST,
      code: "INSUFFICIENT_STOCK",
      message: "No batch with sufficient quantity for this item",
      exposeMessage: true,
    });
  }
  return batch;
}

async function resolveBatchId(args: {
  tx: Prisma.TransactionClient;
  itemId: number;
  quantity: number;
  branchId: number | undefined;
  batchId?: number;
}): Promise<number> {
  if (typeof args.batchId === "number") {
    await getValidatedBatch(args.tx, args.batchId, args.itemId, args.quantity);
    return args.batchId;
  }
  const b = await findFefoBatch(
    args.tx,
    args.itemId,
    args.quantity,
    args.branchId
  );
  return b.id;
}

async function assertInventoryItemInScope(
  tx: Prisma.TransactionClient,
  inventoryItemId: number,
  clinicId: number,
  branchId: number | undefined
) {
  const item = await tx.inventoryItem.findFirst({
    where: {
      id: inventoryItemId,
      clinicId,
      ...(typeof branchId === "number" ? { branchId } : {}),
    },
    select: { id: true },
  });
  if (!item) {
    throw new AppError({
      status: httpCodes.NOT_FOUND,
      code: "INVENTORY_ITEM_NOT_FOUND",
      message: "Inventory item not found in this clinic or branch",
      exposeMessage: true,
    });
  }
}

async function updatePrescriptionAggregateStatus(
  tx: Prisma.TransactionClient,
  prescriptionId: number
): Promise<AutoCompletedVisit | null> {
  const prescription = await tx.prescription.findUnique({
    where: { id: prescriptionId },
    select: {
      id: true,
      status: true,
      visitId: true,
      // Only internally-fulfilled items are dispensed from clinic stock, so
      // only they count toward the served/fully-served aggregate. External
      // lines are filled by the patient outside and never get a dispense line.
      items: {
        where: { fulfilment: PrescriptionItemFulfilment.INTERNAL },
        select: { id: true },
      },
    },
  });
  if (!prescription || prescription.status === PrescriptionStatus.CANCELLED) {
    return null;
  }
  const itemIds = prescription.items.map((i) => i.id);
  if (itemIds.length === 0) {
    return null;
  }
  const dispensed = await tx.pharmacyDispenseLine.findMany({
    where: { prescriptionItemId: { in: itemIds } },
    select: { prescriptionItemId: true },
    distinct: ["prescriptionItemId"],
  });
  const servedCount = dispensed.filter(
    (d) => d.prescriptionItemId != null
  ).length;
  let next: PrescriptionStatus = PrescriptionStatus.ISSUED;
  if (servedCount >= itemIds.length) {
    next = PrescriptionStatus.FULLY_SERVED;
  } else if (servedCount > 0) {
    next = PrescriptionStatus.PARTIALLY_SERVED;
  }
  if (next !== prescription.status) {
    await tx.prescription.update({
      where: { id: prescriptionId },
      data: { status: next },
    });
  }

  // Pharmacy is the patient's last station: once every clinic-dispensed
  // (INTERNAL) line is served there is nothing left to collect, so dispensing
  // the final line completes the visit automatically — no manual "Complete
  // visit" click by the pharmacist. Guard on the visit actually being parked at
  // PHARMACY so we never short-circuit an earlier stage or re-complete a visit.
  if (next !== PrescriptionStatus.FULLY_SERVED) {
    return null;
  }
  const visit = await tx.visit.findUnique({
    where: { id: prescription.visitId },
    select: {
      id: true,
      careStage: true,
      clinicId: true,
      branchId: true,
      patientId: true,
      doctorId: true,
    },
  });
  if (!visit || visit.careStage !== CareStage.PHARMACY) {
    return null;
  }
  await tx.visit.update({
    where: { id: visit.id },
    data: {
      status: VisitStatus.DISCHARGED_WITH_PRESCRIPTION,
      careStage: CareStage.DONE,
      endTime: new Date(),
    },
  });
  return {
    id: visit.id,
    clinicId: visit.clinicId,
    branchId: visit.branchId,
    patientId: visit.patientId,
    doctorId: visit.doctorId,
  };
}

async function tryReturnIdempotentOrder(
  tx: Prisma.TransactionClient,
  key: string,
  clinicId: number,
  userId: number
) {
  const dup = await tx.pharmacyIdempotencyRecord.findUnique({
    where: {
      clinicId_userId_key: { clinicId, userId, key },
    },
  });
  if (!dup) {
    return null;
  }
  return tx.pharmacyDispenseOrder.findUnique({
    where: { id: dup.orderId },
    include: PHARMACY_ORDER_INCLUDE,
  });
}

async function validatePrescriptionInTransaction(
  tx: Prisma.TransactionClient,
  params: ExecuteDispenseParams,
  clinicId: number
): Promise<number | null> {
  if (typeof params.prescriptionId !== "number") {
    for (const line of params.lines) {
      if (line.prescriptionItemId != null) {
        throw new AppError({
          status: httpCodes.BAD_REQUEST,
          code: "PRESCRIPTION_LINE_NOT_ALLOWED",
          message:
            "prescriptionItemId is only valid with a clinic prescription",
          exposeMessage: true,
        });
      }
    }
    return null;
  }

  const rx = await tx.prescription.findFirst({
    where: { id: params.prescriptionId, clinicId },
    include: { items: { select: { id: true } } },
  });
  if (!rx) {
    throw new AppError({
      status: httpCodes.NOT_FOUND,
      code: "PRESCRIPTION_NOT_FOUND",
      message: "Prescription not found",
      exposeMessage: true,
    });
  }
  if (rx.status === PrescriptionStatus.CANCELLED) {
    throw new AppError({
      status: httpCodes.BAD_REQUEST,
      code: "PRESCRIPTION_CANCELLED",
      message: "Cannot dispense a cancelled prescription",
      exposeMessage: true,
    });
  }
  const itemIdSet = new Set(rx.items.map((i) => i.id));
  for (const line of params.lines) {
    if (line.prescriptionItemId == null) {
      continue;
    }
    if (!itemIdSet.has(line.prescriptionItemId)) {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        code: "INVALID_PRESCRIPTION_LINE",
        message: "prescriptionItemId does not belong to this prescription",
        exposeMessage: true,
      });
    }
    const prior = await tx.pharmacyDispenseLine.findFirst({
      where: { prescriptionItemId: line.prescriptionItemId },
    });
    if (prior) {
      throw new AppError({
        status: httpCodes.CONFLICT,
        code: "LINE_ALREADY_DISPENSED",
        message: "This prescription line was already dispensed",
        exposeMessage: true,
      });
    }
  }
  return rx.visitId;
}

async function applyInventoryDeduction(
  tx: Prisma.TransactionClient,
  batchId: number,
  itemId: number,
  quantity: number
) {
  const batchUpdate = await tx.inventoryBatch.updateMany({
    where: {
      id: batchId,
      currentQuantity: { gte: quantity },
    },
    data: { currentQuantity: { decrement: quantity } },
  });
  if (batchUpdate.count !== 1) {
    throw new AppError({
      status: httpCodes.BAD_REQUEST,
      code: "INSUFFICIENT_STOCK",
      message: "No batch with sufficient quantity for this item",
      exposeMessage: true,
    });
  }
  const stockUpdate = await tx.inventoryStock.updateMany({
    where: {
      itemId,
      quantity: { gte: quantity },
    },
    data: { quantity: { decrement: quantity } },
  });
  if (stockUpdate.count !== 1) {
    throw new AppError({
      status: httpCodes.BAD_REQUEST,
      code: "INSUFFICIENT_STOCK",
      message: "Insufficient inventory stock for this item",
      exposeMessage: true,
    });
  }
  await refreshItemStatus(tx, itemId);
}

async function processOneDispenseLine(
  tx: Prisma.TransactionClient,
  args: {
    orderId: string;
    line: DispenseLineInput;
    clinicId: number;
    branchId: number | undefined;
    userId: number;
    visitIdForTxn: number | undefined;
  }
) {
  const { orderId, line, clinicId, branchId, userId, visitIdForTxn } = args;
  await assertInventoryItemInScope(
    tx,
    line.inventoryItemId,
    clinicId,
    branchId
  );

  const batchId = await resolveBatchId({
    tx,
    itemId: line.inventoryItemId,
    quantity: line.quantity,
    branchId,
    batchId: line.batchId,
  });

  const batch = await getValidatedBatch(
    tx,
    batchId,
    line.inventoryItemId,
    line.quantity
  );

  const transactionId = await createNegativeStockTransaction(tx, {
    itemId: line.inventoryItemId,
    batchId,
    quantity: line.quantity,
    unitPrice: batch.unitPrice,
    type: TransactionType.SALE,
    sourceType: SourceType.PHARMACY_DISPENSE,
    visitId: visitIdForTxn,
    userId,
    dispenseOrderId: orderId,
  });

  await applyInventoryDeduction(
    tx,
    batchId,
    line.inventoryItemId,
    line.quantity
  );

  await tx.pharmacyDispenseLine.create({
    data: {
      orderId,
      prescriptionItemId: line.prescriptionItemId ?? null,
      inventoryItemId: line.inventoryItemId,
      batchId,
      quantity: line.quantity,
      transactionId,
    },
  });
}

async function finalizeDispenseOrder(args: {
  tx: Prisma.TransactionClient;
  orderId: string;
  params: ExecuteDispenseParams;
  userId: number;
  clinicId: number;
  key: string | undefined;
}) {
  const { tx, orderId, params, userId, clinicId, key } = args;
  let autoCompletedVisit: AutoCompletedVisit | null = null;
  if (typeof params.prescriptionId === "number") {
    autoCompletedVisit = await updatePrescriptionAggregateStatus(
      tx,
      params.prescriptionId
    );
  }
  if (key) {
    await tx.pharmacyIdempotencyRecord.create({
      data: {
        clinicId,
        userId,
        key,
        orderId,
      },
    });
  }
  const full = await tx.pharmacyDispenseOrder.findUnique({
    where: { id: orderId },
    include: PHARMACY_ORDER_INCLUDE,
  });
  if (!full) {
    throw new AppError({
      status: httpCodes.INTERNAL_SERVER_ERROR,
      code: "DISPENSE_LOAD_FAILED",
      message: "Failed to load dispense order after create",
      exposeMessage: false,
    });
  }
  return { order: full, autoCompletedVisit };
}

export async function runPharmacyDispenseInTransaction(
  tx: Prisma.TransactionClient,
  params: ExecuteDispenseParams,
  userId: number,
  key: string | undefined
) {
  const { clinicId, branchId } = params;

  if (key) {
    const replay = await tryReturnIdempotentOrder(tx, key, clinicId, userId);
    if (replay) {
      return {
        order: replay,
        replayed: true as const,
        autoCompletedVisit: null,
      };
    }
  }

  const prescriptionVisitId = await validatePrescriptionInTransaction(
    tx,
    params,
    clinicId
  );

  const visitIdForTxn = params.visitId ?? prescriptionVisitId ?? undefined;
  const resolvedVisit =
    typeof visitIdForTxn === "number" ? visitIdForTxn : undefined;

  const order = await tx.pharmacyDispenseOrder.create({
    data: {
      id: randomUUID(),
      clinicId,
      branchId: branchId ?? null,
      prescriptionId: params.prescriptionId ?? null,
      visitId: resolvedVisit ?? null,
      patientId: params.patientId ?? null,
      source: params.source,
      externalPrescriberName: params.externalPrescriberName ?? null,
      externalPrescriptionDate: params.externalPrescriptionDate ?? null,
      notes: params.notes ?? null,
      performedByUserId: userId,
    },
  });

  for (const line of params.lines) {
    await processOneDispenseLine(tx, {
      orderId: order.id,
      line,
      clinicId,
      branchId,
      userId,
      visitIdForTxn: resolvedVisit,
    });
  }

  const { order: full, autoCompletedVisit } = await finalizeDispenseOrder({
    tx,
    orderId: order.id,
    params,
    userId,
    clinicId,
    key,
  });
  return { order: full, replayed: false as const, autoCompletedVisit };
}
