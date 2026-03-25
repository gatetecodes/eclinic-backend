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

const baseApprovalSchema = z.object({
  reason: z.string().optional(),
});

const discountApprovalSchema = baseApprovalSchema.extend({
  type: z.literal("DISCOUNT"),
  discountId: z.number().int(),
});

const refundApprovalSchema = baseApprovalSchema.extend({
  type: z.literal("REFUND"),
  payload: z
    .object({
      paymentId: z.number().int(),
      visitId: z.number().int(),
      examId: z.number().int(),
      requested: z
        .object({
          refund: z
            .object({
              patientRefundAmount: z.number(),
              insuranceAdjustmentAmount: z.number(),
              totalAdjustmentAmount: z.number(),
            })
            .passthrough(),
        })
        .passthrough(),
    })
    .passthrough(),
});

const priceOverrideApprovalSchema = baseApprovalSchema.extend({
  type: z.literal("PRICE_OVERRIDE"),
  payload: z.object({}).passthrough(),
});

const examEditApprovalSchema = baseApprovalSchema.extend({
  type: z.literal("EXAM_EDIT"),
  examId: z.number().int(),
  payload: z
    .object({
      paymentId: z.number().int(),
      requested: z
        .object({
          exams: z.array(z.number().int()),
        })
        .passthrough(),
    })
    .passthrough(),
});

const treatmentEditApprovalSchema = baseApprovalSchema.extend({
  type: z.literal("TREATMENT_EDIT"),
  treatmentId: z.number().int(),
  payload: z
    .object({
      requested: z
        .object({
          treatments: z.array(
            z.object({ id: z.number().int(), quantity: z.number().optional() })
          ),
        })
        .passthrough(),
    })
    .passthrough(),
});

const extraInventoryApprovalSchema = baseApprovalSchema.extend({
  type: z.literal("EXTRA_INVENTORY"),
  payload: z.object({}).passthrough(),
});

export const createApprovalSchema = z.union([
  discountApprovalSchema,
  refundApprovalSchema,
  priceOverrideApprovalSchema,
  examEditApprovalSchema,
  treatmentEditApprovalSchema,
  extraInventoryApprovalSchema,
]);

export type CreateApprovalInput = z.infer<typeof createApprovalSchema>;

export const processApprovalSchema = z.object({
  approve: z.boolean(),
});

export type ProcessApprovalInput = z.infer<typeof processApprovalSchema>;
