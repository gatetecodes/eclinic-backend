import { PaymentMethod } from "generated/prisma";
import { z } from "zod";

export const markInsuranceClaimAsPaidSchema = z.object({
  paymentMethod: z.nativeEnum(PaymentMethod),
});
