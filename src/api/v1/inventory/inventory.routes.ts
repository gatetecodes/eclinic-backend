import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { crudAccess } from "../../../middlewares/crud-access.middleware.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";

import {
  addStock,
  createSaleTransaction,
  deleteInventoryItem,
  getAvailableBatches,
  getInventoryBatches,
  getInventoryItems,
  getInventoryItemsList,
  getInventoryTransactions,
  getLatestTransactions,
  getStockTransactions,
  importInventoryItemsFromCSV,
  updateInventoryItem,
} from "./inventory.controller.ts";

import {
  saleTransactionSchema,
  stockTransactionSchema,
} from "./inventory.validation.ts";

const router = new Hono<AppEnv>();
router.use("*", crudAccess("inventory"));

router.get("/", getInventoryItems);
router.get("/latest-transactions", getLatestTransactions);
router.post("/add-stock", validate(stockTransactionSchema, "json"), addStock);
router.post(
  "/create-sale-transaction",

  validate(saleTransactionSchema, "json"),
  createSaleTransaction
);
router.get("/stock-transactions", getStockTransactions);
router.get("/inventory-transactions", getInventoryTransactions);
router.get("/list", getInventoryItemsList);
router.post("/import", importInventoryItemsFromCSV);
router.put("/:id", updateInventoryItem);
router.delete("/:id", deleteInventoryItem);
router.get("/batches", getInventoryBatches);
router.get("/:itemId/batches", getAvailableBatches);

export default router;
