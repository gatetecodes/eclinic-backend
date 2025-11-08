import { parse } from "csv-parse/sync";
import { Decimal } from "generated/prisma/runtime/library";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { buildQueryOptions } from "@/helpers/query-helper";
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
} from "../../../../generated/prisma";
import { db } from "../../../database/db";
import { processInventoryItemRecord } from "../../../helpers/inventory-helpers";
import { httpCodes } from "../../../lib/constants";
import { logger } from "../../../lib/logger";
import {
  DEFAULT_CACHE_TTL,
  getCachedData,
} from "../../../services/redis.service";
import type { ConsumableCSVRow } from "../../../types/inventory-types";

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
        clinicId: user.clinic.id,
        branchId: user.branch.id,
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
    const cacheKey = `inventory:${clinicId ?? "ALL"}:${branchId ?? "ALL"}:${JSON.stringify(params || {})}`;
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
      clinicId: user.clinic.id,
      branchId: user.branch.id,
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
        clinicId: user.clinic.id,
        branchId: user.branch.id,
      },
    });

    await invalidateInventoryRelatedCaches({
      clinicId: user.clinic.id,
      branchId: user.branch.id,
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
    const { itemId } = c.req.param();
    const batches = await db.inventoryBatch.findMany({
      where: {
        itemId: Number(itemId),
        currentQuantity: { gt: 0 },
        expiryDate: { gt: new Date() },
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
          clinicId: user.clinicId ?? user.clinic.id,
          branchId: user.branchId ?? user.branch.id,
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
    const cacheKey = `inventory:${clinicId ?? "ALL"}:${branchId ?? "ALL"}:${JSON.stringify(params || {})}`;

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
    const { data } = c.get("validatedJson");
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
      const batch = await tx.inventoryBatch.create({
        data: {
          itemId,
          batchNumber,
          expiryDate,
          initialQuantity: quantity,
          currentQuantity: quantity,
          unitPrice,
          location,
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
        const currentQuantity = item.currentStock?.quantity + quantity;
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
      return { batch, transaction };
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
    const { itemId, quantity, batchId, visitId, notes } = data;

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

    //biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
    const result = await db.$transaction(async (tx) => {
      const unitPrice = batch.unitPrice;
      const transaction = await tx.transaction.create({
        data: {
          itemId,
          batchId,
          type: TransactionType.SALE,
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
        const currentQuantity = item.currentStock?.quantity - Number(quantity);

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
