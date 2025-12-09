import { parse } from "csv-parse/sync";
import { Decimal } from "generated/prisma/internal/prismaNamespace";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { buildQueryOptions } from "@/helpers/query-helper";
import { AppError } from "@/lib/app-error";
import { invalidateInventoryRelatedCaches } from "@/lib/cache-utils";
import { searchParamsSchema } from "@/lib/common-validation";
import { getScope } from "@/lib/request-scope";
import {
  type InventoryBatch,
  type InventoryItem,
  InventoryStatus,
  type Prisma,
  SourceType,
  type Transaction,
  TransactionStatus,
  TransactionType,
} from "../../../../generated/prisma/client";
import { db } from "../../../database/db";
import { processInventoryItemRecord } from "../../../helpers/inventory-helpers";
import { httpCodes } from "../../../lib/constants";
import { logger } from "../../../lib/logger";
import redis, {
  DEFAULT_CACHE_TTL,
  getCachedData,
} from "../../../services/redis.service";
import type { ConsumableCSVRow } from "../../../types/inventory-types";
import type { StockOutAllocationsInput } from "./inventory.validation";
import {
  disposalSchema,
  goodsReceiptSchema,
  returnSchema,
  stockOutAllocationsSchema,
  stocktakeSchema,
  transferSchema,
} from "./inventory.validation";

export const createInventoryItem = async (c: Context) => {
  try {
    const user = c.get("user");
    const {
      itemName,
      itemType,
      unit,
      reorderLevel,
      manufacturer,
      minOrderQuantity,
      notes,
    } = await c.req.json();
    const inventoryItem = await db.inventoryItem.create({
      data: {
        clinicId: user.clinicId,
        branchId: user.branchId,
        itemName,
        itemType,
        unit,
        reorderLevel,
        manufacturer,
        minOrderQuantity,
        notes,
        currentStock: {
          create: {
            quantity: 0,
          },
        },
      },
      include: {
        currentStock: true,
      },
    });

    await invalidateInventoryRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
    });

    return c.json(inventoryItem, httpCodes.CREATED as ContentfulStatusCode);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getInventoryItems = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId, branchId } = getScope(user, params);
    const cacheKey = `inventory-items:${clinicId ?? "ALL"}:${branchId ?? "ALL"}:${JSON.stringify(params || {})}`;
    const queryOptions = buildQueryOptions<InventoryItem>(params, {
      ...(typeof clinicId === "number" ? { clinicId } : {}),
      ...(typeof branchId === "number" ? { branchId } : {}),
    });

    const { where, orderBy, ...restOptions } = queryOptions;
    const inventoryItems = await getCachedData(
      cacheKey,
      async () => {
        return await db.inventoryItem.findMany({
          where: {
            ...where,
          },
          orderBy: orderBy as Prisma.InventoryItemOrderByWithRelationInput,
          ...restOptions,
          include: {
            currentStock: true,
          },
        });
      },
      DEFAULT_CACHE_TTL.MEDIUM
    );
    const totalCount = await db.inventoryItem.count({
      where: { ...where },
    });

    const pageCount = restOptions.take
      ? Math.ceil(totalCount / restOptions.take)
      : 0;

    return c.json(
      { data: inventoryItems, totalCount, pageCount },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updateInventoryItem = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.req.param();
    const {
      itemName,
      itemType,
      unit,
      reorderLevel,
      manufacturer,
      minOrderQuantity,
      notes,
    } = await c.req.json();
    const updatedInventoryItem = await db.inventoryItem.update({
      where: {
        id: Number(id),
        clinicId: user.clinicId,
        branchId: user.branchId,
      },
      data: {
        itemName,
        itemType,
        unit,
        reorderLevel,
        manufacturer,
        minOrderQuantity,
        notes,
      },
    });

    await invalidateInventoryRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
    });

    return c.json(
      {
        message: "Inventory item updated successfully",
        data: updatedInventoryItem,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const deleteInventoryItem = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.req.param();
    await db.inventoryItem.delete({
      where: {
        id: Number(id),
        clinicId: user.clinicId,
        branchId: user.branchId,
      },
    });

    await invalidateInventoryRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
    });

    return c.json(
      { message: "Inventory item deleted successfully" },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getAvailableBatches = async (c: Context) => {
  try {
    const user = c.get("user");
    const { itemId } = c.req.param();
    const includeNullExpiry =
      (c.req.query("includeNullExpiry") || "false").toLowerCase() === "true";
    const includeExpired =
      (c.req.query("includeExpired") || "false").toLowerCase() === "true";

    let expiryFilter: Record<string, unknown> = {};
    if (!includeExpired) {
      if (includeNullExpiry) {
        expiryFilter = {
          OR: [{ expiryDate: null }, { expiryDate: { gt: new Date() } }],
        };
      } else {
        expiryFilter = { expiryDate: { gt: new Date() } };
      }
    }

    const batches = await db.inventoryBatch.findMany({
      where: {
        itemId: Number(itemId),
        currentQuantity: { gt: 0 },
        ...expiryFilter,
        ...(user?.branchId ? { branchId: user.branchId } : {}),
      },
      orderBy: [{ expiryDate: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        batchNumber: true,
        currentQuantity: true,
        expiryDate: true,
        unitPrice: true,
        location: true,
      },
    });

    return c.json({ data: batches }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getLatestTransactions = async (c: Context) => {
  try {
    const user = c.get("user");
    const transactions = await db.transaction.findMany({
      where: {
        item: {
          clinicId: user.clinicId,
          branchId: user.branchId,
        },
      },
      include: {
        item: true,
        batch: true,
        performedBy: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 8,
    });
    return c.json({ data: transactions }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getInventoryBatches = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId, branchId } = getScope(user, params);
    const cacheKey = `inventory-batches:${clinicId ?? "ALL"}:${branchId ?? "ALL"}:${JSON.stringify(params || {})}`;
    const queryOptions = buildQueryOptions<InventoryBatch>(params);
    const { where, orderBy, ...restOptions } = queryOptions;

    const inventoryBatches = await getCachedData(cacheKey, async () => {
      return await db.inventoryBatch.findMany({
        where: {
          ...where,
          item: {
            ...(typeof clinicId === "number" ? { clinicId } : {}),
            ...(typeof branchId === "number" ? { branchId } : {}),
          },
        },
        orderBy: orderBy as Prisma.InventoryBatchOrderByWithRelationInput,
        ...restOptions,
        include: {
          item: true,
        },
      });
    });
    const totalCount = await db.inventoryBatch.count({
      where: {
        ...where,
        item: {
          ...(typeof clinicId === "number" ? { clinicId } : {}),
          ...(typeof branchId === "number" ? { branchId } : {}),
        },
      },
    });
    const pageCount = restOptions.take
      ? Math.ceil(totalCount / restOptions.take)
      : 0;
    return c.json(
      { data: inventoryBatches, totalCount, pageCount },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const importInventoryItemsFromCSV = async (c: Context) => {
  try {
    const user = c.get("user");
    const { csvContent } = await c.req.json();
    const records: ConsumableCSVRow[] = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
    });
    const sortedRecords = [...records].sort((a, b) => {
      if (a.NAME && !b.NAME) {
        return -1;
      }
      if (!a.NAME && b.NAME) {
        return 1;
      }
      return 0;
    });
    const BATCH_SIZE = 20;
    let successfulImports = 0;
    let failedImports = 0;
    for (let i = 0; i < sortedRecords.length; i += BATCH_SIZE) {
      const batch = sortedRecords.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (record) => {
          try {
            return await processInventoryItemRecord(
              user.clinicId,
              user.branchId
            )(record);
          } catch (error) {
            logger.error(`Error processing consumable ${record.NAME}:`, {
              error,
            });
            return null;
          }
        })
      );

      const batchSuccesses = results.filter(Boolean).length;
      successfulImports += batchSuccesses;
      failedImports += batch.length - batchSuccesses;

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return c.json(
      {
        success: `Successfully imported ${successfulImports} consumables`,
        failedImports,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getInventoryItemsList = async (c: Context) => {
  try {
    const user = c.get("user");
    const inventoryItems = await db.inventoryItem.findMany({
      where: { clinicId: user.clinicId, branchId: user.branchId },
      select: {
        id: true,
        itemName: true,
        unit: true,
      },
    });
    return c.json(
      { data: inventoryItems },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const addStock = async (c: Context) => {
  try {
    const user = c.get("user");
    const idemKey = c.req.header("Idempotency-Key");
    if (idemKey) {
      const key = `idem:inventory:add:${idemKey}`;
      const wasSet = await redis.set(key, "1", "EX", 60 * 5, "NX");
      if (!wasSet) {
        return c.json(
          { error: "Duplicate request" },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
      }
    }
    const data = c.get("validatedJson");
    const {
      itemId,
      quantity,
      unitPrice,
      batchNumber,
      expiryDate,
      location,
      notes,
    } = data;

    //biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
    const result = await db.$transaction(async (tx) => {
      // Prevent duplicate batch numbers per item
      const existing = await tx.inventoryBatch.findFirst({
        where: { itemId, batchNumber },
        select: { id: true },
      });
      if (existing) {
        return Promise.reject(
          new AppError({
            status: httpCodes.CONFLICT,
            code: "DUPLICATE_BATCH",
            message: "Batch number already exists for this item",
            exposeMessage: true,
          })
        );
      }
      const batch = await tx.inventoryBatch.create({
        data: {
          itemId,
          batchNumber,
          expiryDate,
          initialQuantity: quantity,
          currentQuantity: quantity,
          unitPrice,
          location,
          branchId: user.branchId,
        },
      });
      const transaction = await tx.transaction.create({
        data: {
          itemId,
          batchId: batch.id,
          type: TransactionType.PURCHASE,
          quantity: Number(quantity),
          unitPrice: unitPrice ? new Decimal(unitPrice) : null,
          totalAmount: unitPrice
            ? new Decimal(unitPrice).mul(Number(quantity))
            : null,
          sourceType: SourceType.PURCHASE_ORDER,
          notes: notes || null,
          userId: Number(user.id),
          status: TransactionStatus.COMPLETED,
        },
      });
      await tx.inventoryStock.upsert({
        where: { itemId },
        create: { itemId, quantity },
        update: { quantity: { increment: quantity } },
      });
      const item = await tx.inventoryItem.findUnique({
        where: { id: itemId },
        include: { currentStock: true },
      });
      if (item) {
        const currentQuantity = item.currentStock?.quantity ?? 0;
        let newStatus: InventoryStatus = InventoryStatus.IN_STOCK;
        if (currentQuantity === 0) {
          newStatus = InventoryStatus.OUT_OF_STOCK;
        } else if (currentQuantity <= item.reorderLevel) {
          newStatus = InventoryStatus.LOW_STOCK;
        }
        if (newStatus !== item.status) {
          await tx.inventoryItem.update({
            where: { id: itemId },
            data: { status: newStatus },
          });
        }
      }
      return { batch, transaction };
    });

    await invalidateInventoryRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
    });

    return c.json(
      {
        success: true,
        message: "Stock transaction created successfully",
        data: result,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const createSaleTransaction = async (c: Context) => {
  try {
    const user = c.get("user");
    const { data } = c.get("validatedJson");
    const { itemId, quantity, batchId, visitId, notes, type } = data;
    const idemKey = c.req.header("Idempotency-Key");
    if (idemKey) {
      const key = `idem:inventory:sale:${idemKey}`;
      const wasSet = await redis.set(key, "1", "EX", 60 * 5, "NX");
      if (!wasSet) {
        return c.json(
          { error: "Duplicate request" },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
      }
    }

    const batch = await db.inventoryBatch.findUnique({
      where: { id: batchId },
    });

    if (!batch) {
      return c.json(
        { error: "Batch not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (batch.currentQuantity < Number(quantity)) {
      return c.json(
        { error: "Insufficient quantity in selected batch" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    if (batch.itemId !== itemId) {
      return c.json(
        { error: "Batch item ID does not match item ID" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    // Require visitId only for SALE transactions
    if (type === TransactionType.SALE && !visitId) {
      return c.json(
        { error: "visitId is required for SALE transactions" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    //biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
    const result = await db.$transaction(async (tx) => {
      const unitPrice = batch.unitPrice;
      const transaction = await tx.transaction.create({
        data: {
          itemId,
          batchId,
          type,
          quantity: -Number(quantity),
          unitPrice: unitPrice ? new Decimal(unitPrice) : null,
          totalAmount: unitPrice
            ? new Decimal(unitPrice).mul(Number(quantity))
            : null,
          sourceType: SourceType.VISIT,
          visitId,
          notes: notes || null,
          userId: Number(user.id),
          status: TransactionStatus.COMPLETED,
        },
      });

      await tx.inventoryBatch.update({
        where: { id: batchId },
        data: {
          currentQuantity: { decrement: Number(quantity) },
        },
      });
      await tx.inventoryStock.update({
        where: { itemId },
        data: {
          quantity: { decrement: Number(quantity) },
        },
      });
      const item = await tx.inventoryItem.findUnique({
        where: { id: itemId },
        include: { currentStock: true },
      });
      if (item?.currentStock) {
        const currentQuantity = item.currentStock?.quantity ?? 0;

        let newStatus: InventoryStatus = InventoryStatus.IN_STOCK;
        if (currentQuantity === 0) {
          newStatus = InventoryStatus.OUT_OF_STOCK;
        } else if (currentQuantity <= item.reorderLevel) {
          newStatus = InventoryStatus.LOW_STOCK;
        }

        if (newStatus !== item.status) {
          await tx.inventoryItem.update({
            where: { id: itemId },
            data: { status: newStatus },
          });
        }
      }

      await invalidateInventoryRelatedCaches({
        clinicId: user.clinicId,
        branchId: user.branchId,
      });
      return { transaction };
    });
    return c.json(
      {
        success: true,
        message: "Sale transaction created successfully",
        data: result,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getStockTransactions = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId, branchId } = getScope(user, params);
    const cacheKey = `inventory:${clinicId ?? "ALL"}:${branchId ?? "ALL"}:stock-transactions`;
    const queryOptions = buildQueryOptions<Transaction>(params);
    const { where, orderBy, ...restOptions } = queryOptions;

    const transactions = await getCachedData(cacheKey, async () => {
      return await db.transaction.findMany({
        where: {
          ...where,
          item: {
            ...(typeof clinicId === "number" ? { clinicId } : {}),
            ...(typeof branchId === "number" ? { branchId } : {}),
          },
        },
        orderBy: orderBy as Prisma.TransactionOrderByWithRelationInput,
        ...restOptions,
        include: {
          item: true,
          batch: true,
        },
      });
    });
    const totalCount = await db.transaction.count({
      where: {
        ...where,
        item: {
          ...(typeof clinicId === "number" ? { clinicId } : {}),
          ...(typeof branchId === "number" ? { branchId } : {}),
        },
      },
    });
    const pageCount = restOptions.take
      ? Math.ceil(totalCount / restOptions.take)
      : 0;
    return c.json(
      {
        status: httpCodes.OK,
        message: "Stock transactions fetched successfully",
        data: transactions,
        totalCount,
        pageCount,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getInventoryTransactions = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId, branchId } = getScope(user, params);
    const queryOptions = buildQueryOptions<Transaction>(params);
    const { where, orderBy, ...restOptions } = queryOptions;
    const transactions = await db.transaction.findMany({
      where: {
        ...where,
        item: {
          ...(typeof clinicId === "number" ? { clinicId } : {}),
          ...(typeof branchId === "number" ? { branchId } : {}),
        },
      },
      orderBy: orderBy as Prisma.TransactionOrderByWithRelationInput,
      ...restOptions,
      include: {
        item: {
          select: {
            id: true,
            itemName: true,
          },
        },
        batch: {
          select: {
            id: true,
            batchNumber: true,
          },
        },
        performedBy: {
          select: {
            id: true,
            name: true,
          },
        },
        visit: {
          select: {
            id: true,
          },
        },
      },
    });
    const totalCount = await db.transaction.count({
      where: {
        ...where,
        item: {
          ...(typeof clinicId === "number" ? { clinicId } : {}),
          ...(typeof branchId === "number" ? { branchId } : {}),
        },
      },
    });
    const pageCount = restOptions.take
      ? Math.ceil(totalCount / restOptions.take)
      : 0;
    return c.json(
      {
        status: httpCodes.OK,
        message: "Inventory transactions fetched successfully",
        data: transactions,
        totalCount,
        pageCount,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

// FEFO/FIFO allocation helper
async function allocateBatchesForItem(
  tx: Prisma.TransactionClient | typeof db,
  itemId: number,
  requiredQuantity: number
): Promise<Array<{ batchId: number; quantity: number }>> {
  const batches = await tx.inventoryBatch.findMany({
    where: {
      itemId,
      currentQuantity: { gt: 0 },
      OR: [{ expiryDate: null }, { expiryDate: { gt: new Date() } }],
    },
    orderBy: [{ expiryDate: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      currentQuantity: true,
      unitPrice: true,
    },
  });
  let remaining = requiredQuantity;
  const allocations: Array<{ batchId: number; quantity: number }> = [];
  for (const b of batches) {
    if (remaining <= 0) {
      break;
    }
    const take = Math.min(b.currentQuantity, remaining);
    if (take > 0) {
      allocations.push({ batchId: b.id, quantity: take });
      remaining -= take;
    }
  }
  if (remaining > 0) {
    return Promise.reject(
      new AppError({
        status: httpCodes.BAD_REQUEST,
        code: "INSUFFICIENT_STOCK",
        message: "Insufficient stock across available batches",
        exposeMessage: true,
      })
    );
  }
  return allocations;
}

async function validateAllocations(
  tx: Prisma.TransactionClient | typeof db,
  itemId: number,
  allocations: Array<{ batchId: number; quantity: number }>
) {
  const batchIds = allocations.map((a) => a.batchId);
  const batches = await tx.inventoryBatch.findMany({
    where: { id: { in: batchIds } },
    select: { id: true, itemId: true, currentQuantity: true, unitPrice: true },
  });
  const batchById = new Map(batches.map((b) => [b.id, b]));

  for (const a of allocations) {
    const b = batchById.get(a.batchId);
    if (!b) {
      return Promise.reject(
        new AppError({
          status: httpCodes.NOT_FOUND,
          code: "BATCH_NOT_FOUND",
          message: `Batch not found: ${a.batchId}`,
          exposeMessage: true,
        })
      );
    }
    if (b.itemId !== itemId) {
      return Promise.reject(
        new AppError({
          status: httpCodes.BAD_REQUEST,
          code: "BATCH_MISMATCH",
          message: `Batch ${a.batchId} does not belong to item ${itemId}`,
          exposeMessage: true,
        })
      );
    }
    if (b.currentQuantity < a.quantity) {
      return Promise.reject(
        new AppError({
          status: httpCodes.BAD_REQUEST,
          code: "INSUFFICIENT_QUANTITY",
          message: `Insufficient quantity in batch ${a.batchId}`,
          exposeMessage: true,
        })
      );
    }
  }
  return batchById;
}

type BatchLookup = Map<
  number,
  {
    id: number;
    itemId: number;
    currentQuantity: number;
    unitPrice: Decimal | string | number | null;
  }
>;

async function applyAllocations(
  tx: Prisma.TransactionClient | typeof db,
  input: {
    userId: number;
    payload: {
      itemId: number;
      visitId?: number;
      type: TransactionType;
      notes?: string | null;
    };
    allocations: Array<{ batchId: number; quantity: number }>;
    batchById: BatchLookup;
  }
) {
  for (const a of input.allocations) {
    const b = input.batchById.get(a.batchId);
    if (!b) {
      return Promise.reject(
        new AppError({
          status: httpCodes.NOT_FOUND,
          code: "BATCH_NOT_FOUND",
          message: `Batch not found: ${a.batchId}`,
          exposeMessage: true,
        })
      );
    }
    await tx.transaction.create({
      data: {
        itemId: input.payload.itemId,
        batchId: a.batchId,
        type: input.payload.type,
        quantity: -Number(a.quantity),
        unitPrice: b.unitPrice ? new Decimal(b.unitPrice) : null,
        totalAmount: b.unitPrice
          ? new Decimal(b.unitPrice).mul(Number(a.quantity))
          : null,
        sourceType: SourceType.VISIT,
        visitId: input.payload.visitId,
        notes: input.payload.notes || null,
        userId: input.userId,
        status: TransactionStatus.COMPLETED,
      },
    });
    await tx.inventoryBatch.update({
      where: { id: a.batchId },
      data: { currentQuantity: { decrement: Number(a.quantity) } },
    });
  }
}

async function createPositiveAdjustment(
  tx: Prisma.TransactionClient | typeof db,
  input: {
    userId: number;
    itemId: number;
    diff: number;
    reason: string;
    notes?: string | null;
    branchId?: number | null;
  }
) {
  const batch = await tx.inventoryBatch.create({
    data: {
      itemId: input.itemId,
      batchNumber: generateAdjustmentBatchNumber(input.itemId),
      initialQuantity: input.diff,
      currentQuantity: input.diff,
      unitPrice: null,
      location: "STOCKTAKE",
      branchId: input.branchId ?? null,
    },
    select: { id: true },
  });
  await tx.transaction.create({
    data: {
      itemId: input.itemId,
      batchId: batch.id,
      type: TransactionType.ADJUSTMENT,
      quantity: input.diff,
      unitPrice: null,
      totalAmount: null,
      sourceType: SourceType.STOCKTAKE,
      notes: input.notes ? `${input.reason} — ${input.notes}` : input.reason,
      userId: input.userId,
      status: TransactionStatus.COMPLETED,
    },
  });
}

async function applyNegativeAdjustment(
  tx: Prisma.TransactionClient | typeof db,
  input: {
    userId: number;
    itemId: number;
    quantity: number;
    reason: string;
    notes?: string | null;
  }
) {
  const allocations = await allocateBatchesForItem(
    tx,
    input.itemId,
    input.quantity
  );
  const batchIds = allocations.map((a) => a.batchId);
  const batches = await tx.inventoryBatch.findMany({
    where: { id: { in: batchIds } },
    select: { id: true, unitPrice: true },
  });
  const byId = new Map(batches.map((b) => [b.id, b]));
  for (const a of allocations) {
    const b = byId.get(a.batchId);
    await tx.transaction.create({
      data: {
        itemId: input.itemId,
        batchId: a.batchId,
        type: TransactionType.ADJUSTMENT,
        quantity: -a.quantity,
        unitPrice: b?.unitPrice ? new Decimal(b.unitPrice) : null,
        totalAmount: b?.unitPrice
          ? new Decimal(b.unitPrice).mul(a.quantity)
          : null,
        sourceType: SourceType.STOCKTAKE,
        notes: input.notes ? `${input.reason} — ${input.notes}` : input.reason,
        userId: input.userId,
        status: TransactionStatus.COMPLETED,
      },
    });
    await tx.inventoryBatch.update({
      where: { id: a.batchId },
      data: { currentQuantity: { decrement: a.quantity } },
    });
  }
}
export const stockOutMultiBatch = async (c: Context) => {
  try {
    const user = c.get("user");
    const body = await c.req.json<StockOutAllocationsInput>();
    const payload = stockOutAllocationsSchema.parse(body);
    const idemKey = c.req.header("Idempotency-Key");
    if (idemKey) {
      const key = `idem:inventory:stockout:${idemKey}`;
      const wasSet = await redis.set(key, "1", "EX", 60 * 5, "NX");
      if (!wasSet) {
        return c.json(
          { error: "Duplicate request" },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
      }
    }

    // If allocations are not provided, attempt FEFO/FIFO allocation using requiredQuantity
    const hasAllocations =
      payload.allocations && payload.allocations.length > 0;
    let allocations = hasAllocations
      ? (payload.allocations as Array<{ batchId: number; quantity: number }>)
      : [];
    if (
      !hasAllocations &&
      (!payload.requiredQuantity || payload.requiredQuantity <= 0)
    ) {
      return c.json(
        { error: "Either allocations or requiredQuantity must be provided" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const result = await db.$transaction(async (tx) => {
      // Allocate batches inside transaction for proper isolation
      if (!hasAllocations) {
        const requiredQty = payload.requiredQuantity ?? 0;
        allocations = await allocateBatchesForItem(
          tx,
          payload.itemId,
          requiredQty
        );
      }
      const providedQty = allocations.reduce((sum, a) => sum + a.quantity, 0);
      const batchById = await validateAllocations(
        tx,
        payload.itemId,
        allocations
      );
      await applyAllocations(tx, {
        userId: Number(user.id),
        payload: {
          itemId: payload.itemId,
          visitId: payload.visitId,
          type: payload.type,
          notes: payload.notes,
        },
        allocations,
        batchById,
      });
      await tx.inventoryStock.update({
        where: { itemId: payload.itemId },
        data: { quantity: { decrement: Number(providedQty) } },
      });

      // Update item status
      const item = await tx.inventoryItem.findUnique({
        where: { id: payload.itemId },
        include: { currentStock: true },
      });
      if (item?.currentStock) {
        const currentQuantity = item.currentStock.quantity ?? 0;
        let newStatus: InventoryStatus = InventoryStatus.IN_STOCK;
        if (currentQuantity === 0) {
          newStatus = InventoryStatus.OUT_OF_STOCK;
        } else if (currentQuantity <= item.reorderLevel) {
          newStatus = InventoryStatus.LOW_STOCK;
        }
        if (newStatus !== item.status) {
          await tx.inventoryItem.update({
            where: { id: payload.itemId },
            data: { status: newStatus },
          });
        }
      }
      return { totalQuantity: providedQty };
    });

    await invalidateInventoryRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
    });
    return c.json(
      {
        success: true,
        message: "Stock-out processed successfully",
        data: result,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

function generateAdjustmentBatchNumber(itemId: number): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const time = now.getTime().toString(36);
  return `ADJ-${itemId}-${yyyy}${mm}${dd}-${time}`;
}

export const stocktake = async (c: Context) => {
  try {
    const user = c.get("user");
    const { itemId, countedQuantity, reason, notes } = stocktakeSchema.parse(
      await c.req.json()
    );
    const idemKey = c.req.header("Idempotency-Key");
    if (idemKey) {
      const key = `idem:inventory:stocktake:${idemKey}`;
      const wasSet = await redis.set(key, "1", "EX", 60 * 5, "NX");
      if (!wasSet) {
        return c.json(
          { error: "Duplicate request" },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
      }
    }

    const result = await db.$transaction(async (tx) => {
      const stock = await tx.inventoryStock.findUnique({
        where: { itemId },
        select: { quantity: true },
      });
      const currentQty = stock?.quantity ?? 0;
      const diff = countedQuantity - currentQty;
      if (diff === 0) {
        return { adjustedBy: 0 };
      }
      if (diff > 0) {
        await createPositiveAdjustment(tx, {
          userId: Number(user.id),
          itemId,
          diff,
          reason,
          notes,
          branchId: user.branchId ?? null,
        });
      } else {
        await applyNegativeAdjustment(tx, {
          userId: Number(user.id),
          itemId,
          quantity: Math.abs(diff),
          reason,
          notes,
        });
      }

      // Update stock to countedQuantity
      await tx.inventoryStock.upsert({
        where: { itemId },
        create: { itemId, quantity: countedQuantity },
        update: { quantity: countedQuantity },
      });

      // Update item status
      const item = await tx.inventoryItem.findUnique({
        where: { id: itemId },
        include: { currentStock: true },
      });
      if (item?.currentStock) {
        const qty = item.currentStock.quantity ?? 0;
        let newStatus: InventoryStatus = InventoryStatus.IN_STOCK;
        if (qty === 0) {
          newStatus = InventoryStatus.OUT_OF_STOCK;
        } else if (qty <= item.reorderLevel) {
          newStatus = InventoryStatus.LOW_STOCK;
        }
        if (newStatus !== item.status) {
          await tx.inventoryItem.update({
            where: { id: itemId },
            data: { status: newStatus },
          });
        }
      }
      return { adjustedBy: diff };
    });

    await invalidateInventoryRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
    });
    return c.json(
      {
        success: true,
        message: "Stocktake recorded successfully",
        data: result,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

type TransferBatchInfo = {
  id: number;
  itemId: number;
  currentQuantity: number;
  unitPrice: Decimal | string | number | null;
  batchNumber: string;
  expiryDate: Date | null;
  location: string | null;
};

async function validateTransfer(
  tx: Prisma.TransactionClient | typeof db,
  itemId: number,
  allocations: Array<{ batchId: number; quantity: number }>
): Promise<Map<number, TransferBatchInfo>> {
  const batchIds = allocations.map((a) => a.batchId);
  const sourceBatches = await tx.inventoryBatch.findMany({
    where: { id: { in: batchIds } },
    select: {
      id: true,
      itemId: true,
      currentQuantity: true,
      unitPrice: true,
      batchNumber: true,
      expiryDate: true,
      location: true,
    },
  });
  const byId = new Map<number, TransferBatchInfo>(
    sourceBatches.map((b) => [b.id, b as unknown as TransferBatchInfo])
  );
  for (const a of allocations) {
    const b = byId.get(a.batchId);
    if (!b || b.itemId !== itemId || b.currentQuantity < a.quantity) {
      return Promise.reject(
        new AppError({
          status: httpCodes.BAD_REQUEST,
          code: "INVALID_BATCH",
          message: `Invalid or insufficient batch: ${a.batchId}`,
          exposeMessage: true,
        })
      );
    }
  }
  return byId;
}

async function applyTransferForAllocation(
  tx: Prisma.TransactionClient | typeof db,
  input: {
    userId: number;
    itemId: number;
    toBranchId: number;
    allocation: { batchId: number; quantity: number };
    source: TransferBatchInfo;
    notes?: string | null;
  }
) {
  await tx.transaction.create({
    data: {
      itemId: input.itemId,
      batchId: input.allocation.batchId,
      type: TransactionType.TRANSFER,
      quantity: -input.allocation.quantity,
      unitPrice: input.source.unitPrice
        ? new Decimal(input.source.unitPrice)
        : null,
      totalAmount: input.source.unitPrice
        ? new Decimal(input.source.unitPrice).mul(input.allocation.quantity)
        : null,
      sourceType: SourceType.TRANSFER,
      notes: input.notes,
      userId: input.userId,
      status: TransactionStatus.COMPLETED,
    },
  });
  await tx.inventoryBatch.update({
    where: { id: input.allocation.batchId },
    data: { currentQuantity: { decrement: input.allocation.quantity } },
  });
  const destBatch = await tx.inventoryBatch.create({
    data: {
      itemId: input.itemId,
      batchNumber: `${input.source.batchNumber}-XFER-${input.toBranchId}`,
      expiryDate: input.source.expiryDate,
      initialQuantity: input.allocation.quantity,
      currentQuantity: input.allocation.quantity,
      unitPrice: input.source.unitPrice
        ? new Decimal(input.source.unitPrice)
        : null,
      location: input.source.location ?? "TRANSFER",
      branchId: input.toBranchId,
    },
    select: { id: true },
  });
  await tx.transaction.create({
    data: {
      itemId: input.itemId,
      batchId: destBatch.id,
      type: TransactionType.TRANSFER,
      quantity: input.allocation.quantity,
      unitPrice: input.source.unitPrice
        ? new Decimal(input.source.unitPrice)
        : null,
      totalAmount: input.source.unitPrice
        ? new Decimal(input.source.unitPrice).mul(input.allocation.quantity)
        : null,
      sourceType: SourceType.TRANSFER,
      notes: input.notes,
      userId: input.userId,
      status: TransactionStatus.COMPLETED,
    },
  });
}

export const transferInventory = async (c: Context) => {
  try {
    const user = c.get("user");
    const { itemId, toBranchId, allocations, notes } = transferSchema.parse(
      await c.req.json()
    );
    const idemKey = c.req.header("Idempotency-Key");
    if (idemKey) {
      const key = `idem:inventory:transfer:${idemKey}`;
      const wasSet = await redis.set(key, "1", "EX", 60 * 5, "NX");
      if (!wasSet) {
        return c.json(
          { error: "Duplicate request" },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
      }
    }
    const totalQty = allocations.reduce((sum, a) => sum + a.quantity, 0);
    if (totalQty <= 0) {
      return c.json(
        { error: "Total quantity must be greater than zero" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const result = await db.$transaction(async (tx) => {
      const byId = await validateTransfer(tx, itemId, allocations);
      for (const a of allocations) {
        const b = byId.get(a.batchId);
        if (!b) {
          return Promise.reject(
            new AppError({
              status: httpCodes.NOT_FOUND,
              code: "BATCH_NOT_FOUND",
              message: `Batch not found: ${a.batchId}`,
              exposeMessage: true,
            })
          );
        }
        await applyTransferForAllocation(tx, {
          userId: Number(user.id),
          itemId,
          toBranchId,
          allocation: a,
          source: b,
          notes,
        });
      }
      return { transferred: totalQty };
    });
    await invalidateInventoryRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
    });
    return c.json(
      {
        success: true,
        message: "Transfer completed successfully",
        data: result,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

/**
 * Disposes of inventory items: Creates a disposal transaction, updates the inventory stock, updates the expiry notifications, and updates the item status.
 * @param c - The context object
 * @returns The result of the disposal
 */

export const disposeInventory = async (c: Context) => {
  try {
    const user = c.get("user");
    const { itemId, reason, allocations, notes, attachmentUrl } =
      disposalSchema.parse(await c.req.json());
    const idemKey = c.req.header("Idempotency-Key");
    if (idemKey) {
      const key = `idem:inventory:disposal:${idemKey}`;
      const wasSet = await redis.set(key, "1", "EX", 60 * 5, "NX");
      if (!wasSet) {
        return c.json(
          { error: "Duplicate request" },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
      }
    }
    const total = allocations.reduce((s, a) => s + a.quantity, 0);

    //biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
    const result = await db.$transaction(async (tx) => {
      const byId = await validateAllocations(tx, itemId, allocations);
      for (const a of allocations) {
        const b = byId.get(a.batchId);
        if (!b) {
          return Promise.reject(
            new AppError({
              status: httpCodes.NOT_FOUND,
              code: "BATCH_NOT_FOUND",
              message: `Batch not found: ${a.batchId}`,
              exposeMessage: true,
            })
          );
        }
        await tx.transaction.create({
          data: {
            itemId,
            batchId: a.batchId,
            type: TransactionType.DISPOSAL,
            quantity: -a.quantity,
            unitPrice: b.unitPrice ? new Decimal(b.unitPrice) : null,
            totalAmount: b.unitPrice
              ? new Decimal(b.unitPrice).mul(a.quantity)
              : null,
            sourceType: SourceType.DISPOSAL,
            notes: [reason, notes, attachmentUrl].filter(Boolean).join(" — "),
            userId: Number(user.id),
            status: TransactionStatus.COMPLETED,
          },
        });
        await tx.inventoryBatch.update({
          where: { id: a.batchId },
          data: { currentQuantity: { decrement: a.quantity } },
        });
        await tx.inventoryExpiryNotification.updateMany({
          where: { batchId: a.batchId, resolvedAt: null },
          data: { resolvedAt: new Date(), updatedAt: new Date() },
        });
      }
      await tx.inventoryStock.update({
        where: { itemId },
        data: { quantity: { decrement: total } },
      });
      const item = await tx.inventoryItem.findUnique({
        where: { id: itemId },
        include: { currentStock: true },
      });

      //Recomute item status after disposal
      if (item?.currentStock) {
        const qty = item.currentStock.quantity ?? 0;
        let newStatus: InventoryStatus = InventoryStatus.IN_STOCK;
        if (qty === 0) {
          newStatus = InventoryStatus.OUT_OF_STOCK;
        } else if (qty <= item.reorderLevel) {
          newStatus = InventoryStatus.LOW_STOCK;
        }
        if (newStatus !== item.status) {
          await tx.inventoryItem.update({
            where: { id: itemId },
            data: { status: newStatus },
          });
        }
      }
      return { disposed: total };
    });
    await invalidateInventoryRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
    });
    return c.json(
      {
        success: true,
        message: "Disposal recorded successfully",
        data: result,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const returnToStock = async (c: Context) => {
  try {
    const user = c.get("user");
    const { itemId, quantity, notes } = returnSchema.parse(await c.req.json());
    const idemKey = c.req.header("Idempotency-Key");
    if (idemKey) {
      const key = `idem:inventory:return:${idemKey}`;
      const wasSet = await redis.set(key, "1", "EX", 60 * 5, "NX");
      if (!wasSet) {
        return c.json(
          { error: "Duplicate request" },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
      }
    }
    const result = await db.$transaction(async (tx) => {
      const batch = await tx.inventoryBatch.create({
        data: {
          itemId,
          batchNumber: generateAdjustmentBatchNumber(itemId).replace(
            "ADJ",
            "RET"
          ),
          initialQuantity: quantity,
          currentQuantity: quantity,
          unitPrice: null,
          location: "RETURN",
          branchId: user.branchId ?? null,
        },
        select: { id: true },
      });
      await tx.transaction.create({
        data: {
          itemId,
          batchId: batch.id,
          type: TransactionType.RETURN,
          quantity,
          unitPrice: null,
          totalAmount: null,
          sourceType: SourceType.RETURN,
          notes,
          userId: Number(user.id),
          status: TransactionStatus.COMPLETED,
        },
      });
      await tx.inventoryStock.upsert({
        where: { itemId },
        create: { itemId, quantity },
        update: { quantity: { increment: quantity } },
      });
      const item = await tx.inventoryItem.findUnique({
        where: { id: itemId },
        include: { currentStock: true },
      });
      if (item?.currentStock) {
        const qty = item.currentStock.quantity ?? 0;
        let newStatus: InventoryStatus = InventoryStatus.IN_STOCK;
        if (qty === 0) {
          newStatus = InventoryStatus.OUT_OF_STOCK;
        } else if (qty <= item.reorderLevel) {
          newStatus = InventoryStatus.LOW_STOCK;
        }
        if (newStatus !== item.status) {
          await tx.inventoryItem.update({
            where: { id: itemId },
            data: { status: newStatus },
          });
        }
      }
      return { returned: quantity };
    });
    await invalidateInventoryRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
    });
    return c.json(
      { success: true, message: "Return recorded successfully", data: result },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const receiveGoods = async (c: Context) => {
  try {
    const user = c.get("user");
    const { notes, items } = goodsReceiptSchema.parse(await c.req.json());
    const idemKey = c.req.header("Idempotency-Key");
    if (idemKey) {
      const key = `idem:inventory:receive:${idemKey}`;
      const wasSet = await redis.set(key, "1", "EX", 60 * 5, "NX");
      if (!wasSet) {
        return c.json(
          { error: "Duplicate request" },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
      }
    }
    // Validate all items exist
    const itemIds = items.map((item) => item.itemId);
    const existingItems = await db.inventoryItem.findMany({
      where: { id: { in: itemIds } },
      select: { id: true },
    });
    if (existingItems.length !== itemIds.length) {
      const foundIds = new Set(existingItems.map((i) => i.id));
      const missingIds = itemIds.filter((id) => !foundIds.has(id));
      throw new AppError({
        status: httpCodes.NOT_FOUND,
        code: "ITEMS_NOT_FOUND",
        message: `Items not found: ${missingIds.join(", ")}`,
        exposeMessage: true,
      });
    }
    //biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
    const result = await db.$transaction(async (tx) => {
      let totalQty = 0;
      for (const line of items) {
        const batch = await tx.inventoryBatch.create({
          data: {
            itemId: line.itemId,
            batchNumber:
              line.batchNumber ??
              generateAdjustmentBatchNumber(line.itemId).replace("ADJ", "GRN"),
            expiryDate: line.expiryDate ?? null,
            initialQuantity: line.quantity,
            currentQuantity: line.quantity,
            unitPrice:
              line.unitPrice != null ? new Decimal(line.unitPrice) : null,
            location: line.location ?? "RECEIVING",
            branchId: user.branchId ?? null,
          },
          select: { id: true },
        });
        await tx.transaction.create({
          data: {
            itemId: line.itemId,
            batchId: batch.id,
            type: TransactionType.PURCHASE,
            quantity: line.quantity,
            unitPrice:
              line.unitPrice != null ? new Decimal(line.unitPrice) : null,
            totalAmount:
              line.unitPrice != null
                ? new Decimal(line.unitPrice).mul(line.quantity)
                : null,
            sourceType: SourceType.PURCHASE_ORDER,
            notes,
            userId: Number(user.id),
            status: TransactionStatus.COMPLETED,
          },
        });
        await tx.inventoryStock.upsert({
          where: { itemId: line.itemId },
          create: { itemId: line.itemId, quantity: line.quantity },
          update: { quantity: { increment: line.quantity } },
        });
        totalQty += line.quantity;
      }

      //Keep status in synch after goods receipt
      // Get all unique item IDs from the receipt
      const uniqueItemIds = [...new Set(items.map((item) => item.itemId))];

      // Batch fetch all inventory items with their current stock
      const inventoryItems = await tx.inventoryItem.findMany({
        where: { id: { in: uniqueItemIds } },
        include: { currentStock: true },
      });

      // Update status for each item that has changed
      for (const item of inventoryItems) {
        if (item.currentStock) {
          const qty = item.currentStock.quantity ?? 0;
          let newStatus: InventoryStatus = InventoryStatus.IN_STOCK;
          if (qty === 0) {
            newStatus = InventoryStatus.OUT_OF_STOCK;
          } else if (qty <= item.reorderLevel) {
            newStatus = InventoryStatus.LOW_STOCK;
          }
          if (newStatus !== item.status) {
            await tx.inventoryItem.update({
              where: { id: item.id },
              data: { status: newStatus },
            });
          }
        }
      }
      return { received: items.length, totalQuantity: totalQty };
    });
    await invalidateInventoryRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
    });
    return c.json(
      { success: true, message: "Goods received successfully", data: result },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getInventoryValuation = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId, branchId } = getScope(user, params);
    const batches = await db.inventoryBatch.findMany({
      where: {
        item: {
          ...(typeof clinicId === "number" ? { clinicId } : {}),
          ...(typeof branchId === "number" ? { branchId } : {}),
        },
      },
      select: {
        itemId: true,
        currentQuantity: true,
        unitPrice: true,
        item: { select: { id: true, itemName: true } },
      },
    });
    const map = new Map<
      number,
      { itemId: number; itemName: string; quantity: number; valuation: number }
    >();
    for (const b of batches) {
      const unit = b.unitPrice ? Number(b.unitPrice) : 0;
      const amount = unit * b.currentQuantity;
      const entry = map.get(b.itemId) ?? {
        itemId: b.item.id,
        itemName: b.item.itemName,
        quantity: 0,
        valuation: 0,
      };
      entry.quantity += b.currentQuantity;
      entry.valuation += amount;
      map.set(b.itemId, entry);
    }
    const data = Array.from(map.values());
    return c.json({ data }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getLowStockItems = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId, branchId } = getScope(user, params);
    const items = await db.inventoryItem.findMany({
      where: {
        status: {
          in: [InventoryStatus.LOW_STOCK, InventoryStatus.OUT_OF_STOCK],
        },
        ...(typeof clinicId === "number" ? { clinicId } : {}),
        ...(typeof branchId === "number" ? { branchId } : {}),
      },
      select: {
        id: true,
        itemName: true,
        status: true,
        reorderLevel: true,
        currentStock: true,
      },
    });
    return c.json({ data: items }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getNearExpiryBatches = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId, branchId } = getScope(user, params);
    const threshold = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const batches = await db.inventoryBatch.findMany({
      where: {
        currentQuantity: { gt: 0 },
        expiryDate: { gte: new Date(), lte: threshold },
        item: {
          ...(typeof clinicId === "number" ? { clinicId } : {}),
          ...(typeof branchId === "number" ? { branchId } : {}),
        },
      },
      select: {
        id: true,
        batchNumber: true,
        expiryDate: true,
        currentQuantity: true,
        unitPrice: true,
        item: { select: { id: true, itemName: true } },
      },
      orderBy: [{ expiryDate: "asc" }],
    });
    return c.json({ data: batches }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
