import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "@/lib/constants";
import type { ItemType, Prisma } from "../../../../generated/prisma";
import { db } from "../../../database/db";

export const listInventory = async (c: Context) => {
  try {
    const {
      page = "1",
      limit = "10",
      search = "",
      category = "",
    } = c.req.query();

    const skip = (Number.parseInt(page, 10) - 1) * Number.parseInt(limit, 10);
    const take = Number.parseInt(limit, 10);

    const where: Prisma.InventoryItemWhereInput = {};
    if (search) {
      where.OR = [
        { itemName: { contains: search, mode: "insensitive" } },
        { manufacturer: { contains: search, mode: "insensitive" } },
        { notes: { contains: search, mode: "insensitive" } },
      ];
    }
    if (category) {
      where.itemType = category as ItemType;
    }

    const [items, total] = await Promise.all([
      db.inventoryItem.findMany({
        where,
        skip,
        take,
        include: { clinic: true, branch: true },
        orderBy: { createdAt: "desc" },
      }),
      db.inventoryItem.count({ where }),
    ]);

    return c.json({
      data: items,
      total,
      page: Number.parseInt(page, 10),
      limit: Number.parseInt(limit, 10),
      totalPages: Math.ceil(total / Number.parseInt(limit, 10)),
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
