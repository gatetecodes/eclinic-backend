import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.ts";
import {
  deleteInventoryItem,
  getAvailableBatches,
  getInventoryBatches,
  getInventoryItems,
  getInventoryItemsList,
  getLatestTransactions,
  importInventoryItemsFromCSV,
  updateInventoryItem,
} from "./inventory.controller.ts";

const router = new Hono<AppEnv>();

router.get("/", getInventoryItems);
router.get("/list", getInventoryItemsList);
router.post("/import", importInventoryItemsFromCSV);
router.put("/:id", updateInventoryItem);
router.delete("/:id", deleteInventoryItem);
router.get("/batches", getAvailableBatches);
router.get("/batches/:id", getInventoryBatches);
router.get("/latest-transactions", getLatestTransactions);

export default router;
