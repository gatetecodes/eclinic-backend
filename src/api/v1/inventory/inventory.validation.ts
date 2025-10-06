import { TransactionType } from "@prisma/client";
import { z } from "zod";

export const stockTransactionSchema = z.object({
  itemId: z.number(),
  quantity: z.string().transform((val) => Number.parseInt(val, 10)),
  batchNumber: z.string().min(1, "Batch number is required"),
  expiryDate: z
    .string()
    .optional()
    .transform((val) => (val ? new Date(val) : null)),
  unitPrice: z
    .string()
    .optional()
    .transform((val) => (val ? Number.parseFloat(val) : null)),
  location: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export const saleTransactionSchema = z.object({
  itemId: z.number(),
  visitId: z
    .string()
    .transform((val) => Number.parseInt(val, 10))
    .optional(),
  quantity: z.string().transform((val) => Number.parseInt(val, 10)),
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

export type ListInventoryQuery = z.infer<typeof listInventoryQuerySchema>;
