import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth";
import { listNotifications } from "./notifications.controller.ts";

const router = new Hono<AppEnv>();

router.get("/", listNotifications);

export default router;
