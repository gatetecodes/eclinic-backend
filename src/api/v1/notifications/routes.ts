import { Hono } from "hono";
import * as NotificationsController from "./notifications.controller.ts";
import type { AppEnv } from "../../../middlewares/auth";

const router = new Hono<AppEnv>();

router.get("/", NotificationsController.listNotifications);

export default router;
