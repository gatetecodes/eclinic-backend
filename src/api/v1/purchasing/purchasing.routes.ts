import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { crudAccess } from "../../../middlewares/crud-access.middleware.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  createPurchaseOrder,
  createSupplier,
  deleteSupplier,
  getPurchaseOrderById,
  getPurchaseOrders,
  getSuppliers,
  getSuppliersList,
  receivePurchaseOrder,
  updatePurchaseOrder,
  updateSupplier,
} from "./purchasing.controller.ts";
import {
  createPurchaseOrderSchema,
  createSupplierSchema,
  receivePurchaseOrderSchema,
  updatePurchaseOrderSchema,
  updateSupplierSchema,
} from "./purchasing.validation.ts";

// Procurement reuses the "inventory" RBAC resource: the roles that manage
// inventory (CLINIC_ADMIN, BRANCH_ADMIN, STOCK_MANAGER) are exactly those that
// should manage suppliers and purchase orders.

export const suppliersRouter = new Hono<AppEnv>();
suppliersRouter.use("*", crudAccess("inventory"));
suppliersRouter.post(
  "/",
  validate(createSupplierSchema, "json"),
  createSupplier
);
suppliersRouter.get("/", getSuppliers);
suppliersRouter.get("/list", getSuppliersList);
suppliersRouter.put(
  "/:id",
  validate(updateSupplierSchema, "json"),
  updateSupplier
);
suppliersRouter.delete("/:id", deleteSupplier);

export const purchaseOrdersRouter = new Hono<AppEnv>();
purchaseOrdersRouter.use("*", crudAccess("inventory"));
purchaseOrdersRouter.post(
  "/",
  validate(createPurchaseOrderSchema, "json"),
  createPurchaseOrder
);
purchaseOrdersRouter.get("/", getPurchaseOrders);
purchaseOrdersRouter.get("/:id", getPurchaseOrderById);
purchaseOrdersRouter.put(
  "/:id",
  validate(updatePurchaseOrderSchema, "json"),
  updatePurchaseOrder
);
purchaseOrdersRouter.post("/:id/approve", approvePurchaseOrder);
purchaseOrdersRouter.post("/:id/cancel", cancelPurchaseOrder);
purchaseOrdersRouter.post(
  "/:id/receive",
  validate(receivePurchaseOrderSchema, "json"),
  receivePurchaseOrder
);
