import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { crudAccess } from "../../../middlewares/crud-access.middleware.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";
import {
  createNotification,
  getUnreadNotifications,
  markNotificationAsRead,
} from "./notifications.controller.ts";
import { notificationSchema } from "./notifications.validation.ts";

const router = new Hono<AppEnv>();
router.use("*", crudAccess("notifications"));

router.post("/", validate(notificationSchema, "json"), createNotification);
router.get("/unread", getUnreadNotifications);
router.put("/:id/read", markNotificationAsRead);

export default router;
