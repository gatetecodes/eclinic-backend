import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "@/lib/constants.ts";
import { db } from "../../../database/db";
import {
  getVisitTimelineParamsSchema,
  logActivitySchema,
} from "./activity.validation.ts";

// Using centralized validation from activity.validation.ts

export const logActivity = async (c: Context) => {
  try {
    const user = c.get("user");
    const json = await c.req.json();
    const parsed = logActivitySchema.safeParse(json);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten() },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
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

    return c.json(
      { success: true, data: activityLog },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getVisitActivitiesTimeline = async (c: Context) => {
  try {
    const parsedParams = getVisitTimelineParamsSchema.safeParse(c.req.param());
    if (!parsedParams.success) {
      return c.json(
        { error: parsedParams.error.flatten() },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const id = Number(parsedParams.data.visitId);
    if (!Number.isFinite(id)) {
      return c.json(
        { error: "Invalid visit id" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const activities = await db.activityLog.findMany({
      where: { visitId: id },
      include: { user: { select: { name: true } } },
      orderBy: { timestamp: "asc" },
    });

    return c.json({ success: true, data: activities });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
