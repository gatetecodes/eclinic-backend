import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { crudAccess } from "../../../middlewares/crud-access.middleware.ts";
import { listNotifications } from "./notifications.controller.ts";

const router = new Hono<AppEnv>();
router.use("*", crudAccess("notifications"));

router.get("/", listNotifications);

export default router;
