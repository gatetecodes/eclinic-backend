import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { crudAccess } from "../../../middlewares/crud-access.middleware.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";

import {
  addStock,
  createInventoryItem,
  createSaleTransaction,
  deleteInventoryItem,
  disposeInventory,
  getAvailableBatches,
  getInventoryBatches,
  getInventoryItems,
  getInventoryItemsList,
  getInventoryTransactions,
  getInventoryValuation,
  getLatestTransactions,
  getLowStockItems,
  getNearExpiryBatches,
  getStockItemDetails,
  getStockTransactions,
  importInventoryItemsFromCSV,
  receiveGoods,
  returnToStock,
  stockOutMultiBatch,
  stocktake,
  transferInventory,
  updateInventoryItem,
} from "./inventory.controller.ts";

import {
  createInventoryItemSchema,
  disposalSchema,
  goodsReceiptSchema,
  returnSchema,
  saleTransactionSchema,
  stockOutAllocationsSchema,
  stockTransactionSchema,
  stocktakeSchema,
  transferSchema,
} from "./inventory.validation.ts";

const router = new Hono<AppEnv>();
router.use("*", crudAccess("inventory"));

// Create item
router.post(
  "/",
  validate(createInventoryItemSchema, "json"),
  createInventoryItem
);
router.get("/", getInventoryItems);
router.get("/latest-transactions", getLatestTransactions);
router.post("/add-stock", validate(stockTransactionSchema, "json"), addStock);
router.post(
  "/create-sale-transaction",

  validate(saleTransactionSchema, "json"),
  createSaleTransaction
);
router.post(
  "/stock-out",
  validate(stockOutAllocationsSchema, "json"),
  stockOutMultiBatch
);
router.post("/stocktake", validate(stocktakeSchema, "json"), stocktake);
router.post("/transfer", validate(transferSchema, "json"), transferInventory);
router.post("/disposal", validate(disposalSchema, "json"), disposeInventory);
router.post("/return", validate(returnSchema, "json"), returnToStock);
router.post("/receive", validate(goodsReceiptSchema, "json"), receiveGoods);
router.get("/valuation", getInventoryValuation);
router.get("/low-stock", getLowStockItems);
router.get("/near-expiry", getNearExpiryBatches);
router.get("/stock-transactions", getStockTransactions);
router.get("/inventory-transactions", getInventoryTransactions);
router.get("/list", getInventoryItemsList);
router.post("/import", importInventoryItemsFromCSV);
router.put("/:id", updateInventoryItem);
router.delete("/:id", deleteInventoryItem);
router.get("/batches", getInventoryBatches);
router.get("/:itemId/batches", getAvailableBatches);
router.get("/:itemId/details", getStockItemDetails);

export default router;
