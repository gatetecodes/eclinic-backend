import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { httpCodes } from "@/lib/constants.ts";
import { db } from "../../../database/db";
import type { notificationSchema } from "./notifications.validation";

export const createNotification = async (c: Context) => {
  try {
    const data = c.get("validatedJson") as z.infer<typeof notificationSchema>;
    const notification = await db.notification.create({
      data: {
        userId: data.userId,
        title: data.title,
        message: data.message,
        type: data.type,
      },
    });
    return c.json({
      data: notification,
    });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const markNotificationAsRead = async (c: Context) => {
  try {
    const { id } = c.req.param();
    const notificationId = Number.parseInt(id, 10);
    if (Number.isNaN(notificationId)) {
      return c.json(
        { error: "Invalid notificationId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const notification = await db.notification.findUnique({
      where: { id: notificationId },
    });
    if (!notification) {
      return c.json(
        { error: "Notification not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (notification.isRead) {
      return c.json(
        { error: "Notification already read" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    await db.notification.update({
      where: { id: notificationId },
      data: { isRead: true },
    });
    return c.json({ success: "Notification marked as read" });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getUnreadNotifications = async (c: Context) => {
  try {
    const { id } = c.req.param();
    const notificationId = Number.parseInt(id, 10);
    if (Number.isNaN(notificationId)) {
      return c.json(
        { error: "Invalid notificationId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const notifications = await db.notification.findMany({
      where: { userId: notificationId, isRead: false },
      orderBy: { createdAt: "desc" },
    });
    return c.json({
      success: "Notifications fetched successfully",
      notifications,
    });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
