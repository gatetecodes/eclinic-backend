import { z } from "zod";
import {
  SubscriptionPlan,
  SubscriptionStatus,
} from "../../../../generated/prisma/client";

export const getClinicParamsSchema = z.object({ id: z.string() });

export type GetClinicParams = z.infer<typeof getClinicParamsSchema>;

export const adminSchema = z.object({
  name: z.string().min(1),
  email: z.email(),
  phone_number: z.string().min(10),
});

export const clinicSchema = z.object({
  name: z.string().min(1),
  subscriptionPlan: z.enum(SubscriptionPlan),
  contactPhone: z.string(),
  contactEmail: z.email(),
  admin: adminSchema,
  expiryDate: z.any().optional(),
});

export const updateClinicSchema = z.object({
  name: z.string().min(1),
  subscriptionPlan: z.enum(SubscriptionPlan),
  contactPhone: z.string(),
  contactEmail: z.email(),
  expiryDate: z.any().optional(),
});

export const updateClinicAdminSchema = z.object({
  name: z.string().min(1),
  email: z.email(),
  phone_number: z.string().min(10),
});

export const updateClinicSubscriptionStatusSchema = z.object({
  subscriptionStatus: z.enum(SubscriptionStatus),
});

export type UpdateClinicSchema = z.infer<typeof updateClinicSchema>;
export type UpdateClinicAdminSchema = z.infer<typeof updateClinicAdminSchema>;
