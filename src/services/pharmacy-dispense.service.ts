import { db } from "@/database/db";
import { AppError } from "@/lib/app-error";
import { httpCodes } from "@/lib/constants";
import { DispenseOrderSource, Prisma } from "../../generated/prisma/client";
import type { ExecuteDispenseParams } from "../types/pharmacy-dispense.types.ts";
import {
  PHARMACY_ORDER_INCLUDE,
  runPharmacyDispenseInTransaction,
} from "./pharmacy-dispense-run-tx.ts";

export type {
  DispenseLineInput,
  ExecuteDispenseParams,
} from "../types/pharmacy-dispense.types.ts";

function isPrismaUniqueViolation(
  error: unknown
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function loadOrderPayload(orderId: string) {
  return db.pharmacyDispenseOrder.findUnique({
    where: { id: orderId },
    include: PHARMACY_ORDER_INCLUDE,
  });
}

function validateDispenseParams(params: ExecuteDispenseParams) {
  if (params.lines.length === 0) {
    throw new AppError({
      status: httpCodes.BAD_REQUEST,
      code: "EMPTY_DISPENSE",
      message: "At least one line is required",
      exposeMessage: true,
    });
  }
  if (
    params.source === DispenseOrderSource.CLINIC_PRESCRIPTION &&
    typeof params.prescriptionId !== "number"
  ) {
    throw new AppError({
      status: httpCodes.BAD_REQUEST,
      code: "PRESCRIPTION_REQUIRED",
      message: "prescriptionId is required for clinic prescriptions",
      exposeMessage: true,
    });
  }
}

async function tryReplayFromIdempotencyKey(
  clinicId: number,
  userId: number,
  key: string | undefined
) {
  if (!key) {
    return null;
  }
  const existing = await db.pharmacyIdempotencyRecord.findUnique({
    where: {
      clinicId_userId_key: { clinicId, userId, key },
    },
  });
  if (!existing) {
    return null;
  }
  const order = await loadOrderPayload(existing.orderId);
  return order ? { order, replayed: true as const } : null;
}

export async function executeDispense(params: ExecuteDispenseParams) {
  const userId = params.user.id;
  if (typeof userId !== "number") {
    throw new AppError({
      status: httpCodes.BAD_REQUEST,
      code: "USER_ID_REQUIRED",
      message: "Authenticated user id is required",
      exposeMessage: true,
    });
  }

  const { clinicId } = params;
  const key = params.idempotencyKey?.trim();

  validateDispenseParams(params);

  const earlyReplay = await tryReplayFromIdempotencyKey(clinicId, userId, key);
  if (earlyReplay) {
    return earlyReplay;
  }

  try {
    return await db.$transaction((tx) =>
      runPharmacyDispenseInTransaction(tx, params, userId, key)
    );
  } catch (error) {
    if (key && isPrismaUniqueViolation(error)) {
      const lateReplay = await tryReplayFromIdempotencyKey(
        clinicId,
        userId,
        key
      );
      if (lateReplay) {
        return lateReplay;
      }
    }
    throw error;
  }
}

export async function upsertPrescriptionItemMap(params: {
  clinicId: number;
  prescriptionItemId: number;
  inventoryItemId: number;
  branchId: number | undefined;
}) {
  const item = await db.inventoryItem.findFirst({
    where: {
      id: params.inventoryItemId,
      clinicId: params.clinicId,
      ...(typeof params.branchId === "number"
        ? { branchId: params.branchId }
        : {}),
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

  const line = await db.prescriptionItem.findFirst({
    where: {
      id: params.prescriptionItemId,
      prescription: {
        clinicId: params.clinicId,
        ...(typeof params.branchId === "number"
          ? { branchId: params.branchId }
          : {}),
      },
    },
    include: {
      prescription: { select: { clinicId: true, branchId: true } },
    },
  });
  if (!line) {
    throw new AppError({
      status: httpCodes.NOT_FOUND,
      code: "PRESCRIPTION_ITEM_NOT_FOUND",
      message: "Prescription line not found in this clinic or branch",
      exposeMessage: true,
    });
  }

  return db.pharmacyPrescriptionItemMap.upsert({
    where: { prescriptionItemId: params.prescriptionItemId },
    create: {
      prescriptionItemId: params.prescriptionItemId,
      inventoryItemId: params.inventoryItemId,
      clinicId: params.clinicId,
    },
    update: { inventoryItemId: params.inventoryItemId },
    include: {
      inventoryItem: { select: { id: true, itemName: true, unitPrice: true } },
    },
  });
}

export async function deletePrescriptionItemMap(params: {
  clinicId: number;
  prescriptionItemId: number;
  branchId: number | undefined;
}) {
  const map = await db.pharmacyPrescriptionItemMap.findFirst({
    where: {
      prescriptionItemId: params.prescriptionItemId,
      clinicId: params.clinicId,
      prescriptionItem: {
        prescription: {
          ...(typeof params.branchId === "number"
            ? { branchId: params.branchId }
            : {}),
        },
      },
    },
  });
  if (!map) {
    throw new AppError({
      status: httpCodes.NOT_FOUND,
      code: "MAP_NOT_FOUND",
      message: "No inventory mapping for this prescription line",
      exposeMessage: true,
    });
  }
  await db.pharmacyPrescriptionItemMap.delete({
    where: { id: map.id },
  });
}
