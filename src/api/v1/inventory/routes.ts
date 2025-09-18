import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth";
import { listInventory } from "./inventory.controller.ts";

const router = new Hono<AppEnv>();

router.get("/", listInventory);

export default router;
