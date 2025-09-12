import { type Context } from "hono";
import { db } from "../../../database/db";
import type { Prisma, ItemType } from "../../../../generated/prisma";

export const listInventory = async (c: Context) => {
  try {
    const {
      page = "1",
      limit = "10",
      search = "",
      category = "",
    } = c.req.query();

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where: Prisma.InventoryItemWhereInput = {};
    if (search) {
      where.OR = [
        { itemName: { contains: search, mode: "insensitive" } },
        { manufacturer: { contains: search, mode: "insensitive" } },
        { notes: { contains: search, mode: "insensitive" } },
      ];
    }
    if (category) where.itemType = category as ItemType;

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
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (error) {
    console.error("Get inventory error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};
