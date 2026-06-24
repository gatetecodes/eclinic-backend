import { z } from "zod";

export const createSupplierSchema = z.object({
  name: z.string().min(1, "Supplier name is required"),
  contact: z
    .string()
    .optional()
    .transform((val) => val || null),
  email: z
    .string()
    .email("Invalid email")
    .optional()
    .or(z.literal(""))
    .transform((val) => val || null),
  phone: z
    .string()
    .optional()
    .transform((val) => val || null),
  address: z
    .string()
    .optional()
    .transform((val) => val || null),
});
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

export const updateSupplierSchema = createSupplierSchema.partial();
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;

const purchaseOrderLineSchema = z.object({
  itemId: z.number(),
  quantity: z.number().int().positive("Quantity must be greater than zero"),
  unitPrice: z.number().nonnegative().optional(),
  notes: z
    .string()
    .optional()
    .transform((val) => val || null),
});

export const createPurchaseOrderSchema = z.object({
  supplierId: z.number(),
  notes: z
    .string()
    .optional()
    .transform((val) => val || null),
  lines: z
    .array(purchaseOrderLineSchema)
    .min(1, "At least one line is required"),
});
export type CreatePurchaseOrderInput = z.infer<
  typeof createPurchaseOrderSchema
>;

export const updatePurchaseOrderSchema = z.object({
  supplierId: z.number().optional(),
  notes: z
    .string()
    .optional()
    .transform((val) => val || null),
  lines: z.array(purchaseOrderLineSchema).min(1).optional(),
});
export type UpdatePurchaseOrderInput = z.infer<
  typeof updatePurchaseOrderSchema
>;

/**
 * Receiving a purchase order. When `lines` is omitted every line is received in
 * full (one-click receive). When provided, each entry receives a partial
 * quantity against a specific PO line, optionally carrying batch/expiry data.
 */
export const receivePurchaseOrderSchema = z.object({
  notes: z
    .string()
    .optional()
    .transform((val) => val || null),
  lines: z
    .array(
      z.object({
        lineId: z.number(),
        quantity: z.number().int().positive(),
        batchNumber: z
          .string()
          .optional()
          .transform((val) => val || null),
        expiryDate: z
          .string()
          .optional()
          .transform((val) => (val ? new Date(val) : null)),
        location: z
          .string()
          .optional()
          .transform((val) => val || null),
      })
    )
    .optional(),
});
export type ReceivePurchaseOrderInput = z.infer<
  typeof receivePurchaseOrderSchema
>;
