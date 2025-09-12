import { Hono } from "hono";
import * as InventoryController from "./inventory.controller.ts";
import type { AppEnv } from "../../../middlewares/auth";

const router = new Hono<AppEnv>();

router.get("/", InventoryController.listInventory);

export default router;
