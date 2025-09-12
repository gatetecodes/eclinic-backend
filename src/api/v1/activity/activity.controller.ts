import { type Context } from "hono";
import { db } from "../../../database/db";
import {
  logActivitySchema,
  getVisitTimelineParamsSchema,
} from "./activity.validation.ts";

// Using centralized validation from activity.validation.ts

export const logActivity = async (c: Context) => {
  try {
    const user = c.get("user");
    const json = await c.req.json();
    const parsed = logActivitySchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const { visitId, action, type, duration, eventId } = parsed.data;

    const activityLog = await db.activityLog.create({
      data: {
        visitId,
        eventId,
        action,
        duration,
        userId: Number(user.id),
        type,
      },
    });

    return c.json({ success: true, data: activityLog }, 201);
  } catch (error) {
    console.error("Log activity error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};

export const getVisitActivitiesTimeline = async (c: Context) => {
  try {
    const parsedParams = getVisitTimelineParamsSchema.safeParse(c.req.param());
    if (!parsedParams.success) {
      return c.json({ error: parsedParams.error.flatten() }, 400);
    }
    const id = Number(parsedParams.data.visitId);
    if (!Number.isFinite(id)) {
      return c.json({ error: "Invalid visit id" }, 400);
    }

    const activities = await db.activityLog.findMany({
      where: { visitId: id },
      include: { user: { select: { name: true } } },
      orderBy: { timestamp: "asc" },
    });

    return c.json({ success: true, data: activities });
  } catch (error) {
    console.error("Get visit activities error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};
