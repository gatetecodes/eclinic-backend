import { Hono } from "hono";
import * as AdminController from "./admin.controller.ts";
import type { AppEnv } from "../../../middlewares/auth";
import { requireAdmin } from "../../../middlewares/auth";

const router = new Hono<AppEnv>();

router.use("*", requireAdmin);
router.get("/stats", AdminController.getStats);

export default router;
