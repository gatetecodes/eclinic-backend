import { type Context } from "hono";
import { db } from "../../../database/db";

export const listNotifications = async (c: Context) => {
  try {
    const user = c.get("user");
    const { page = "1", limit = "10", unread = "false" } = c.req.query();

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where: { userId: number; read?: boolean } = {
      userId: Number(user.id),
    };
    if (unread === "true") where.read = false;

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
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (error) {
    console.error("Get notifications error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};
