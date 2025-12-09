import { PaymentMethod } from "generated/prisma/client";
import { z } from "zod";

export const markInsuranceClaimAsPaidSchema = z.object({
  paymentMethod: z.nativeEnum(PaymentMethod),
});
