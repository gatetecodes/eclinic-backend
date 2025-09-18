import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "@/lib/constants.ts";
import { db } from "../../../database/db";

export const listNotifications = async (c: Context) => {
  try {
    const user = c.get("user");
    const { page = "1", limit = "10", unread = "false" } = c.req.query();

    const skip = (Number.parseInt(page, 10) - 1) * Number.parseInt(limit, 10);
    const take = Number.parseInt(limit, 10);

    const where: { userId: number; read?: boolean } = {
      userId: Number(user.id),
    };
    if (unread === "true") {
      where.read = false;
    }

    const [notifications, total] = await Promise.all([
      db.notification.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
      }),
      db.notification.count({ where }),
    ]);

    return c.json({
      data: notifications,
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
