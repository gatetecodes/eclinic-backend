import { Decimal } from "generated/prisma/internal/prismaNamespace";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AppError } from "@/lib/app-error";
import { invalidateInventoryRelatedCaches } from "@/lib/cache-utils";
import { searchParamsSchema } from "@/lib/common-validation";
import { httpCodes } from "@/lib/constants";
import { getScope } from "@/lib/request-scope";
import {
  POStatus,
  type Prisma,
  SourceType,
} from "../../../../generated/prisma/client";
import { db } from "../../../database/db";
import { applyGoodsReceiptLine } from "../../../helpers/inventory-helpers";
import redis from "../../../services/redis.service";

function errorResponse(c: Context, error: unknown) {
  if (error instanceof AppError) {
    return error.toResponse(c);
  }
  return c.json(
    { error: error instanceof Error ? error.message : "Internal Server Error" },
    httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Suppliers                                 */
/* -------------------------------------------------------------------------- */

export const createSupplier = async (c: Context) => {
  try {
    const user = c.get("user");
    const data = c.get("validatedJson");
    const supplier = await db.supplier.create({
      data: {
        clinicId: user.clinicId,
        name: data.name,
        contact: data.contact,
        email: data.email,
        phone: data.phone,
        address: data.address,
      },
    });
    return c.json(supplier, httpCodes.CREATED as ContentfulStatusCode);
  } catch (error) {
    return errorResponse(c, error);
  }
};

export const getSuppliers = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId } = getScope(user, params);
    const suppliers = await db.supplier.findMany({
      where: {
        ...(typeof clinicId === "number" ? { clinicId } : {}),
        ...(params.name
          ? { name: { contains: params.name, mode: "insensitive" } }
          : {}),
      },
      orderBy: { name: "asc" },
    });
    return c.json({ data: suppliers }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return errorResponse(c, error);
  }
};

export const getSuppliersList = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId } = getScope(user, params);
    const suppliers = await db.supplier.findMany({
      where: { ...(typeof clinicId === "number" ? { clinicId } : {}) },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    return c.json({ data: suppliers }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return errorResponse(c, error);
  }
};

export const updateSupplier = async (c: Context) => {
  try {
    const user = c.get("user");
    const id = Number.parseInt(c.req.param("id"), 10);
    const data = c.get("validatedJson");
    const existing = await db.supplier.findFirst({
      where: { id, clinicId: user.clinicId },
      select: { id: true },
    });
    if (!existing) {
      throw new AppError({
        status: httpCodes.NOT_FOUND,
        code: "SUPPLIER_NOT_FOUND",
        message: "Supplier not found",
        exposeMessage: true,
      });
    }
    const supplier = await db.supplier.update({ where: { id }, data });
    return c.json(supplier, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return errorResponse(c, error);
  }
};

export const deleteSupplier = async (c: Context) => {
  try {
    const user = c.get("user");
    const id = Number.parseInt(c.req.param("id"), 10);
    const existing = await db.supplier.findFirst({
      where: { id, clinicId: user.clinicId },
      select: { id: true, _count: { select: { purchaseOrders: true } } },
    });
    if (!existing) {
      throw new AppError({
        status: httpCodes.NOT_FOUND,
        code: "SUPPLIER_NOT_FOUND",
        message: "Supplier not found",
        exposeMessage: true,
      });
    }
    if (existing._count.purchaseOrders > 0) {
      throw new AppError({
        status: httpCodes.CONFLICT,
        code: "SUPPLIER_IN_USE",
        message: "Cannot delete a supplier that has purchase orders",
        exposeMessage: true,
      });
    }
    await db.supplier.delete({ where: { id } });
    return c.json({ success: true }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return errorResponse(c, error);
  }
};

/* -------------------------------------------------------------------------- */
/*                              Purchase orders                               */
/* -------------------------------------------------------------------------- */

/**
 * Sum of received quantities per item across every goods receipt linked to a
 * purchase order. GoodsReceipt is the source of truth for what has arrived.
 */
async function receivedByItemForPo(poId: number): Promise<Map<number, number>> {
  const grouped = await db.goodsReceiptLine.groupBy({
    by: ["itemId"],
    where: { goodsReceipt: { purchaseOrderId: poId } },
    _sum: { quantity: true },
  });
  return new Map(grouped.map((g) => [g.itemId, g._sum.quantity ?? 0]));
}

/** Distribute already-received quantities across a PO's lines, in order. */
function remainingByLine(
  lines: Array<{ id: number; itemId: number; quantity: number }>,
  received: Map<number, number>
): Map<number, number> {
  const left = new Map(received);
  const remaining = new Map<number, number>();
  for (const line of lines) {
    const available = left.get(line.itemId) ?? 0;
    const consumed = Math.min(available, line.quantity);
    remaining.set(line.id, line.quantity - consumed);
    left.set(line.itemId, available - consumed);
  }
  return remaining;
}

export const createPurchaseOrder = async (c: Context) => {
  try {
    const user = c.get("user");
    const { supplierId, notes, lines } = c.get("validatedJson");

    const supplier = await db.supplier.findFirst({
      where: { id: supplierId, clinicId: user.clinicId },
      select: { id: true },
    });
    if (!supplier) {
      throw new AppError({
        status: httpCodes.NOT_FOUND,
        code: "SUPPLIER_NOT_FOUND",
        message: "Supplier not found",
        exposeMessage: true,
      });
    }

    const itemIds = [
      ...new Set(lines.map((l: { itemId: number }) => l.itemId)),
    ];
    const existingItems = await db.inventoryItem.findMany({
      where: { id: { in: itemIds }, clinicId: user.clinicId },
      select: { id: true },
    });
    if (existingItems.length !== itemIds.length) {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        code: "INVALID_ITEMS",
        message: "One or more items do not belong to this clinic",
        exposeMessage: true,
      });
    }

    const po = await db.purchaseOrder.create({
      data: {
        clinicId: user.clinicId,
        supplierId,
        status: POStatus.DRAFT,
        notes,
        lines: {
          create: lines.map(
            (l: {
              itemId: number;
              quantity: number;
              unitPrice?: number;
              notes?: string | null;
            }) => ({
              itemId: l.itemId,
              quantity: l.quantity,
              unitPrice: l.unitPrice != null ? new Decimal(l.unitPrice) : null,
              notes: l.notes ?? null,
            })
          ),
        },
      },
      include: { supplier: true, lines: { include: { item: true } } },
    });
    return c.json(po, httpCodes.CREATED as ContentfulStatusCode);
  } catch (error) {
    return errorResponse(c, error);
  }
};

export const getPurchaseOrders = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId } = getScope(user, params);
    const where: Prisma.PurchaseOrderWhereInput = {
      ...(typeof clinicId === "number" ? { clinicId } : {}),
      ...(params.status
        ? { status: { in: params.status.split(".") as POStatus[] } }
        : {}),
    };
    const orders = await db.purchaseOrder.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true } },
        lines: {
          select: { id: true, itemId: true, quantity: true, unitPrice: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return c.json({ data: orders }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return errorResponse(c, error);
  }
};

export const getPurchaseOrderById = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId } = getScope(user, params);
    const id = Number.parseInt(c.req.param("id"), 10);
    const po = await db.purchaseOrder.findFirst({
      where: {
        id,
        ...(typeof clinicId === "number" ? { clinicId } : {}),
      },
      include: {
        supplier: true,
        lines: {
          include: {
            item: { select: { id: true, itemName: true, unit: true } },
          },
        },
        receipts: { include: { lines: true }, orderBy: { createdAt: "desc" } },
      },
    });
    if (!po) {
      throw new AppError({
        status: httpCodes.NOT_FOUND,
        code: "PO_NOT_FOUND",
        message: "Purchase order not found",
        exposeMessage: true,
      });
    }
    const received = await receivedByItemForPo(id);
    const remaining = remainingByLine(po.lines, received);
    const lines = po.lines.map((line) => {
      const remainingQty = remaining.get(line.id) ?? 0;
      return {
        ...line,
        unitPrice: line.unitPrice != null ? Number(line.unitPrice) : null,
        quantityReceived: line.quantity - remainingQty,
        quantityRemaining: remainingQty,
      };
    });
    return c.json(
      { data: { ...po, lines } },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return errorResponse(c, error);
  }
};

export const updatePurchaseOrder = async (c: Context) => {
  try {
    const user = c.get("user");
    const id = Number.parseInt(c.req.param("id"), 10);
    const { supplierId, notes, lines } = c.get("validatedJson");
    const po = await db.purchaseOrder.findFirst({
      where: { id, clinicId: user.clinicId },
      select: { id: true, status: true },
    });
    if (!po) {
      throw new AppError({
        status: httpCodes.NOT_FOUND,
        code: "PO_NOT_FOUND",
        message: "Purchase order not found",
        exposeMessage: true,
      });
    }
    if (po.status !== POStatus.DRAFT) {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        code: "PO_NOT_EDITABLE",
        message: "Only draft purchase orders can be edited",
        exposeMessage: true,
      });
    }
    const updated = await db.$transaction(async (tx) => {
      if (lines) {
        await tx.purchaseOrderLine.deleteMany({
          where: { purchaseOrderId: id },
        });
        await tx.purchaseOrderLine.createMany({
          data: lines.map(
            (l: {
              itemId: number;
              quantity: number;
              unitPrice?: number;
              notes?: string | null;
            }) => ({
              purchaseOrderId: id,
              itemId: l.itemId,
              quantity: l.quantity,
              unitPrice: l.unitPrice != null ? new Decimal(l.unitPrice) : null,
              notes: l.notes ?? null,
            })
          ),
        });
      }
      return await tx.purchaseOrder.update({
        where: { id },
        data: {
          ...(supplierId ? { supplierId } : {}),
          notes,
        },
        include: { supplier: true, lines: { include: { item: true } } },
      });
    });
    return c.json(updated, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return errorResponse(c, error);
  }
};

function transitionPurchaseOrder(target: POStatus) {
  return async (c: Context) => {
    try {
      const user = c.get("user");
      const id = Number.parseInt(c.req.param("id"), 10);
      const po = await db.purchaseOrder.findFirst({
        where: { id, clinicId: user.clinicId },
        select: { id: true, status: true },
      });
      if (!po) {
        throw new AppError({
          status: httpCodes.NOT_FOUND,
          code: "PO_NOT_FOUND",
          message: "Purchase order not found",
          exposeMessage: true,
        });
      }
      if (po.status === POStatus.RECEIVED || po.status === POStatus.CANCELLED) {
        throw new AppError({
          status: httpCodes.BAD_REQUEST,
          code: "PO_FINALIZED",
          message: `Cannot change a ${po.status.toLowerCase()} purchase order`,
          exposeMessage: true,
        });
      }
      const updated = await db.purchaseOrder.update({
        where: { id },
        data: { status: target },
      });
      return c.json(updated, httpCodes.OK as ContentfulStatusCode);
    } catch (error) {
      return errorResponse(c, error);
    }
  };
}

export const approvePurchaseOrder = transitionPurchaseOrder(POStatus.APPROVED);
export const cancelPurchaseOrder = transitionPurchaseOrder(POStatus.CANCELLED);

type PoLine = {
  id: number;
  itemId: number;
  quantity: number;
  unitPrice: Decimal | null;
};

type ReceiveEntry = {
  lineId: number;
  itemId: number;
  quantity: number;
  unitPrice: Decimal | null;
  batchNumber: string | null;
  expiryDate: Date | null;
  location: string | null;
};

type ReceiveRequestLine = {
  lineId: number;
  quantity: number;
  batchNumber: string | null;
  expiryDate: Date | null;
  location: string | null;
};

/** Validate an explicit partial-receipt request against remaining quantities. */
function buildRequestedEntries(
  requestLines: ReceiveRequestLine[],
  lineById: Map<number, PoLine>,
  remaining: Map<number, number>
): ReceiveEntry[] {
  return requestLines.map((req) => {
    const line = lineById.get(req.lineId);
    if (!line) {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        code: "INVALID_PO_LINE",
        message: `Line ${req.lineId} does not belong to this purchase order`,
        exposeMessage: true,
      });
    }
    const remainingQty = remaining.get(line.id) ?? 0;
    if (req.quantity > remainingQty) {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        code: "OVER_RECEIPT",
        message: `Cannot receive ${req.quantity}; only ${remainingQty} remaining on line ${line.id}`,
        exposeMessage: true,
      });
    }
    return {
      lineId: line.id,
      itemId: line.itemId,
      quantity: req.quantity,
      unitPrice: line.unitPrice,
      batchNumber: req.batchNumber,
      expiryDate: req.expiryDate,
      location: req.location,
    };
  });
}

/** Default one-click receive: take every outstanding quantity on every line. */
function buildOutstandingEntries(
  lines: PoLine[],
  remaining: Map<number, number>
): ReceiveEntry[] {
  const entries: ReceiveEntry[] = [];
  for (const line of lines) {
    const remainingQty = remaining.get(line.id) ?? 0;
    if (remainingQty > 0) {
      entries.push({
        lineId: line.id,
        itemId: line.itemId,
        quantity: remainingQty,
        unitPrice: line.unitPrice,
        batchNumber: null,
        expiryDate: null,
        location: null,
      });
    }
  }
  return entries;
}

/** Persist a goods receipt and feed each line into the batch/stock system. */
async function persistGoodsReceipt(
  tx: Prisma.TransactionClient,
  args: {
    po: { id: number; supplierId: number };
    clinicId: number;
    userId: number;
    branchId: number | null;
    notes: string | null;
    toReceive: ReceiveEntry[];
    remaining: Map<number, number>;
  }
) {
  const receipt = await tx.goodsReceipt.create({
    data: {
      clinicId: args.clinicId,
      supplierId: args.po.supplierId,
      purchaseOrderId: args.po.id,
      notes: args.notes,
    },
    select: { id: true },
  });
  for (const entry of args.toReceive) {
    await tx.goodsReceiptLine.create({
      data: {
        goodsReceiptId: receipt.id,
        itemId: entry.itemId,
        quantity: entry.quantity,
        unitPrice: entry.unitPrice,
        batchNumber: entry.batchNumber,
        expiryDate: entry.expiryDate,
        notes: args.notes,
      },
    });
    await applyGoodsReceiptLine(
      tx,
      {
        itemId: entry.itemId,
        quantity: entry.quantity,
        unitPrice: entry.unitPrice,
        batchNumber: entry.batchNumber,
        expiryDate: entry.expiryDate,
        location: entry.location,
      },
      {
        userId: args.userId,
        branchId: args.branchId,
        notes: args.notes,
        sourceType: SourceType.PURCHASE_ORDER,
      }
    );
  }

  const newRemaining = new Map(args.remaining);
  for (const entry of args.toReceive) {
    newRemaining.set(
      entry.lineId,
      (newRemaining.get(entry.lineId) ?? 0) - entry.quantity
    );
  }
  const fullyReceived = [...newRemaining.values()].every((q) => q <= 0);
  const nextStatus = fullyReceived ? POStatus.RECEIVED : POStatus.APPROVED;
  await tx.purchaseOrder.update({
    where: { id: args.po.id },
    data: { status: nextStatus },
  });

  return {
    goodsReceiptId: receipt.id,
    linesReceived: args.toReceive.length,
    status: nextStatus,
  };
}

export const receivePurchaseOrder = async (c: Context) => {
  try {
    const user = c.get("user");
    const id = Number.parseInt(c.req.param("id"), 10);
    const body = c.get("validatedJson");

    const idemKey = c.req.header("Idempotency-Key");
    if (idemKey) {
      const key = `idem:purchasing:receive:${idemKey}`;
      const wasSet = await redis.set(key, "1", "EX", 60 * 5, "NX");
      if (!wasSet) {
        return c.json(
          { error: "Duplicate request" },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
      }
    }

    const po = await db.purchaseOrder.findFirst({
      where: { id, clinicId: user.clinicId },
      include: { lines: true },
    });
    if (!po) {
      throw new AppError({
        status: httpCodes.NOT_FOUND,
        code: "PO_NOT_FOUND",
        message: "Purchase order not found",
        exposeMessage: true,
      });
    }
    if (po.status === POStatus.RECEIVED || po.status === POStatus.CANCELLED) {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        code: "PO_NOT_RECEIVABLE",
        message: `Cannot receive a ${po.status.toLowerCase()} purchase order`,
        exposeMessage: true,
      });
    }

    const received = await receivedByItemForPo(id);
    const remaining = remainingByLine(po.lines, received);
    const lineById = new Map(po.lines.map((l) => [l.id, l]));

    const toReceive =
      body.lines && body.lines.length > 0
        ? buildRequestedEntries(body.lines, lineById, remaining)
        : buildOutstandingEntries(po.lines, remaining);

    if (toReceive.length === 0) {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        code: "NOTHING_TO_RECEIVE",
        message: "This purchase order has already been fully received",
        exposeMessage: true,
      });
    }

    const result = await db.$transaction((tx) =>
      persistGoodsReceipt(tx, {
        po,
        clinicId: user.clinicId,
        userId: Number(user.id),
        branchId: user.branchId ?? null,
        notes: body.notes ?? null,
        toReceive,
        remaining,
      })
    );

    await invalidateInventoryRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
    });

    return c.json(
      { success: true, message: "Purchase order received", data: result },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return errorResponse(c, error);
  }
};
