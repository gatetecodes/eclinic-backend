import { PaymentMethod } from "generated/prisma/client";
import { z } from "zod";

export const markPaymentAsPaidSchema = z.object({
  amount: z.coerce.number().min(1, { message: "Amount is required" }),
  paymentMethod: z.nativeEnum(PaymentMethod),
});

export const createDiscountSchema = z.object({
  amount: z.number().min(1, { message: "Amount is required" }),
  reason: z.string().min(1, { message: "Reason is required" }),
});

export const requestExamRefundApprovalSchema = z.object({
  examResultId: z.coerce.number().int(),
  reason: z.string().optional(),
});

export type MarkPaymentAsPaid = z.infer<typeof markPaymentAsPaidSchema>;
