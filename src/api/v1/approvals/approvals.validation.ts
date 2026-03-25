import { z } from "zod";

export const approvalTypeValues = [
  "DISCOUNT",
  "REFUND",
  "PRICE_OVERRIDE",
  "EXAM_EDIT",
  "TREATMENT_EDIT",
  "EXTRA_INVENTORY",
] as const;

export const approvalStatusValues = [
  "PENDING",
  "APPROVED",
  "REJECTED",
] as const;

export const createApprovalSchema = z.object({
  type: z.enum(approvalTypeValues),
  reason: z.string().optional(),
  discountId: z.number().int().optional(),
  examId: z.number().int().optional(),
  treatmentId: z.number().int().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type CreateApprovalInput = z.infer<typeof createApprovalSchema>;

export const processApprovalSchema = z.object({
  approve: z.boolean(),
});

export type ProcessApprovalInput = z.infer<typeof processApprovalSchema>;
