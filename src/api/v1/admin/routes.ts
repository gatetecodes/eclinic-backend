import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth";
import { requireAdmin } from "../../../middlewares/auth";
import { getStats } from "./admin.controller.ts";

const router = new Hono<AppEnv>();

router.use("*", requireAdmin);
router.get("/stats", getStats);

export default router;
