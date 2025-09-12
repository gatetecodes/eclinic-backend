import { z } from "zod";

export const approvalTypeValues = [
  "DISCOUNT",
  "REFUND",
  "PRICE_OVERRIDE",
] as const;

export const approvalStatusValues = [
  "PENDING",
  "APPROVED",
  "REJECTED",
] as const;

export const createApprovalSchema = z.object({
  type: z.enum(approvalTypeValues),
  reason: z.string().optional(),
  // Relation context
  discountId: z.number().int().optional(),
});

export type CreateApprovalInput = z.infer<typeof createApprovalSchema>;

export const processApprovalSchema = z.object({
  approve: z.boolean(),
});

export type ProcessApprovalInput = z.infer<typeof processApprovalSchema>;
