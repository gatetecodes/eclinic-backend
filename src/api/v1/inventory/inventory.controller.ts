import { parse } from "csv-parse/sync";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { buildQueryOptions } from "@/helpers/query-helper";
import { invalidateInventoryRelatedCaches } from "@/lib/cache-utils";
import { searchParamsSchema } from "@/lib/common-validation";
import type {
  InventoryBatch,
  InventoryItem,
  Prisma,
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
    const cacheKey = `inventory:${user.clinic.id}:${user.branch.id}:${JSON.stringify(params || {})}`;
    const queryOptions = buildQueryOptions<InventoryItem>(params);

    const { where, orderBy, ...restOptions } = queryOptions;
    const inventoryItems = await getCachedData(
      cacheKey,
      async () => {
        return await db.inventoryItem.findMany({
          where: {
            ...where,
            clinicId: user.clinic.id,
            branchId: user.branch.id,
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
      where: { ...where, clinicId: user.clinic.id, branchId: user.branch.id },
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
        clinicId: user.clinic.id,
        branchId: user.branch.id,
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
          clinicId: user.clinic.id,
          branchId: user.branch.id,
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
    const cacheKey = `inventory:${user.clinic.id}:${user.branch.id}:${JSON.stringify(params || {})}`;

    const queryOptions = buildQueryOptions<InventoryBatch>(params);
    const { where, orderBy, ...restOptions } = queryOptions;

    const inventoryBatches = await getCachedData(cacheKey, async () => {
      return await db.inventoryBatch.findMany({
        where: {
          ...where,
          item: {
            clinicId: user.clinic.id,
            branchId: user.branch.id,
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
          clinicId: user.clinic.id,
          branchId: user.branch.id,
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
              user.clinic.id,
              user.branch.id
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
      where: { clinicId: user.clinic.id },
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
