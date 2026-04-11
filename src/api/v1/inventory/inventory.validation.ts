import { z } from "zod";
import {
  ItemType,
  TransactionType,
  Unit,
} from "../../../../generated/prisma/client";

export const stockTransactionSchema = z.object({
  itemId: z.number(),
  quantity: z
    .string()
    .transform((val) => Number.parseInt(val, 10))
    .refine((val) => Number.isFinite(val), {
      message: "Quantity must be a valid number",
    })
    .refine((val) => val > 0, {
      message: "Quantity must be greater than zero",
    }),
  batchNumber: z.string().min(1, "Batch number is required"),
  expiryDate: z
    .string()
    .optional()
    .transform((val) => (val ? new Date(val) : null)),
  unitPrice: z
    .string()
    .optional()
    .transform((val) => (val ? Number.parseFloat(val) : null))
    .refine((val) => val == null || val >= 0, {
      message: "Unit price must be non-negative",
    }),
  location: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export const saleTransactionSchema = z.object({
  itemId: z.number(),
  visitId: z
    .string()
    .transform((val) => Number.parseInt(val, 10))
    .optional(),
  quantity: z
    .string()
    .transform((val) => Number.parseInt(val, 10))
    .refine((val) => Number.isFinite(val), {
      message: "Quantity must be a valid number",
    })
    .refine((val) => val > 0, {
      message: "Quantity must be greater than zero",
    }),
  batchId: z.number(),
  type: z.enum(TransactionType),
  notes: z
    .string()
    .optional()
    .transform((val) => val || null),
});

export const listInventoryQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  search: z.string().optional(),
  category: z.string().optional(),
});

export type StockTransactionFormData = z.infer<typeof stockTransactionSchema>;
export type SaleTransactionFormData = z.infer<typeof saleTransactionSchema>;

export type ListInventoryQuery = z.infer<typeof listInventoryQuerySchema>;

// Multi-batch stock-out schema
export const stockOutAllocationsSchema = z.object({
  itemId: z.number(),
  type: z.enum(TransactionType),
  visitId: z.number().optional(),
  requiredQuantity: z.number().positive().optional(),
  allocations: z
    .array(
      z.object({
        batchId: z.number(),
        quantity: z.number().positive(),
      })
    )
    .optional()
    .default([])
    .refine(
      (allocs) =>
        allocs.every((a) => Number.isFinite(a.quantity) && a.quantity > 0),
      { message: "Allocation quantities must be positive numbers" }
    ),
  notes: z
    .string()
    .optional()
    .transform((val) => val || null),
});

export type StockOutAllocationsInput = z.infer<
  typeof stockOutAllocationsSchema
>;

export const stocktakeSchema = z.object({
  itemId: z.number(),
  countedQuantity: z.number().nonnegative(),
  reason: z.string().min(1),
  notes: z
    .string()
    .optional()
    .transform((val) => val || null),
});
export type StocktakeInput = z.infer<typeof stocktakeSchema>;

export const transferSchema = z.object({
  itemId: z.number(),
  toBranchId: z.number(),
  allocations: z
    .array(
      z.object({
        batchId: z.number(),
        quantity: z.number().positive(),
      })
    )
    .min(1),
  notes: z
    .string()
    .optional()
    .transform((val) => val || null),
});
export type TransferInput = z.infer<typeof transferSchema>;

export const disposalSchema = z.object({
  itemId: z.number(),
  reason: z.string().min(1),
  attachmentUrl: z.string().url().optional(),
  allocations: z
    .array(
      z.object({
        batchId: z.number(),
        quantity: z.number().positive(),
      })
    )
    .min(1),
  notes: z
    .string()
    .optional()
    .transform((val) => val || null),
});
export type DisposalInput = z.infer<typeof disposalSchema>;

export const returnSchema = z.object({
  itemId: z.number(),
  quantity: z.number().positive(),
  notes: z
    .string()
    .optional()
    .transform((val) => val || null),
});
export type ReturnInput = z.infer<typeof returnSchema>;

export const goodsReceiptSchema = z.object({
  supplierId: z.number(),
  notes: z
    .string()
    .optional()
    .transform((val) => val || null),
  items: z
    .array(
      z.object({
        itemId: z.number(),
        quantity: z.number().positive(),
        unitPrice: z.number().nonnegative().optional(),
        batchNumber: z.string().min(1).optional(),
        expiryDate: z
          .string()
          .optional()
          .transform((v) => (v ? new Date(v) : null)),
        location: z
          .string()
          .optional()
          .transform((v) => v || null),
      })
    )
    .min(1),
});
export type GoodsReceiptInput = z.infer<typeof goodsReceiptSchema>;

// Create Inventory Item
export const createInventoryItemSchema = z.object({
  itemName: z.string().min(1, "Item name is required"),
  sku: z
    .string()
    .trim()
    .transform((value) => (value === "" ? null : value))
    .optional()
    .nullable(),
  itemType: z.enum(ItemType),
  unit: z.enum(Unit),
  reorderLevel: z.number().int().nonnegative(),
  manufacturer: z.string().optional(),
  minOrderQuantity: z.number().int().nonnegative().optional(),
  notes: z.string().optional(),
});
