import type { ActivityType } from "../../generated/prisma";
import { db } from "../database/db";
import { logger } from "../lib/logger";

export const logActivity = async ({
  userId,
  visitId,
  action,
  type,
  duration,
  eventId,
}: {
  userId: number;
  visitId?: number;
  action: string;
  type: ActivityType;
  duration?: number;
  eventId?: number;
}) => {
  try {
    const activityLog = await db.activityLog.create({
      data: {
        visitId,
        eventId,
        action,
        duration,
        userId,
        type,
      },
    });
    return { success: true, data: activityLog };
  } catch (error) {
    logger.error("Error logging activity: ", { error });
    return { error: "Failed to log activity" };
  }
};
