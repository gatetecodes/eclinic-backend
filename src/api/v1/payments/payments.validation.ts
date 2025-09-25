import { PaymentMethod } from "generated/prisma";
import { z } from "zod";

export const markPaymentAsPaidSchema = z.object({
  amount: z.number().min(1, { message: "Amount is required" }),
  paymentMethod: z.nativeEnum(PaymentMethod),
});

export type MarkPaymentAsPaid = z.infer<typeof markPaymentAsPaidSchema>;
