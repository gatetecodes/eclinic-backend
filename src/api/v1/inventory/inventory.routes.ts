import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { crudAccess } from "../../../middlewares/crud-access.middleware.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";

import {
  addStock,
  adjustStock,
  createInventoryItem,
  createSaleTransaction,
  deleteInventoryItem,
  disposeInventory,
  getAvailableBatches,
  getInventoryBatches,
  getInventoryItems,
  getInventoryItemsList,
  getInventoryTerminologyOptions,
  getInventoryTransactions,
  getInventoryValuation,
  getLatestTransactions,
  getLowStockItems,
  getNearExpiryBatches,
  getReorderSuggestions,
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
  adjustStockSchema,
  createInventoryItemSchema,
  disposalSchema,
  goodsReceiptSchema,
  returnSchema,
  saleTransactionSchema,
  stockOutAllocationsSchema,
  stockTransactionSchema,
  stocktakeSchema,
  transferSchema,
  updateInventoryItemSchema,
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
router.post("/adjust-stock", validate(adjustStockSchema, "json"), adjustStock);
router.get("/reorder-suggestions", getReorderSuggestions);
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
router.get("/terminology-options", getInventoryTerminologyOptions);
router.post("/import", importInventoryItemsFromCSV);
router.put(
  "/:id",
  validate(updateInventoryItemSchema, "json"),
  updateInventoryItem
);
router.delete("/:id", deleteInventoryItem);
router.get("/batches", getInventoryBatches);
router.get("/:itemId/batches", getAvailableBatches);
router.get("/:itemId/details", getStockItemDetails);

export default router;
