import { z } from "zod";
import { SubscriptionPlan } from "../../../../generated/prisma";

export const getClinicParamsSchema = z.object({ id: z.string() });

export type GetClinicParams = z.infer<typeof getClinicParamsSchema>;

export const adminSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone_number: z.string().min(10),
});

export const clinicSchema = z.object({
  name: z.string().min(1),
  subscriptionPlan: z.nativeEnum(SubscriptionPlan),
  admin: adminSchema,
  expiryDate: z.any().optional(),
});
