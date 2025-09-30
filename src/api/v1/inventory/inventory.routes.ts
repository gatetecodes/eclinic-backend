import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.ts";
import { crudAccess } from "../../../middlewares/crud-access";
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
router.use("*", crudAccess("inventory"));

router.get("/", getInventoryItems);
router.get("/list", getInventoryItemsList);
router.post("/import", importInventoryItemsFromCSV);
router.put("/:id", updateInventoryItem);
router.delete("/:id", deleteInventoryItem);
router.get("/batches", getInventoryBatches);
router.get("/batches/:itemId", getAvailableBatches);
router.get("/latest-transactions", getLatestTransactions);

export default router;
