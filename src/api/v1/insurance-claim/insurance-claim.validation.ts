import { PaymentMethod } from "generated/prisma/client";
import { z } from "zod";

export const markInsuranceClaimAsPaidSchema = z.object({
  paymentMethod: z.nativeEnum(PaymentMethod),
});

export const recordInsuranceDeductionSchema = z.object({
  deductedAmount: z.coerce
    .number()
    .min(0, "Deducted amount must be non-negative"),
  deductionReason: z.string().optional(),
});
