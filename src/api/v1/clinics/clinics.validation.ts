import { z } from "zod";
import {
  CurrencyCode,
  SubscriptionPlan,
  SubscriptionStatus,
} from "../../../../generated/prisma/client";

const countryCodeSchema = z.string().regex(/^[A-Za-z]{2}$/, {
  message: "Operating country must be a valid 2-letter ISO code",
});

export const getClinicParamsSchema = z.object({ id: z.string() });

export type GetClinicParams = z.infer<typeof getClinicParamsSchema>;

export const adminSchema = z.object({
  name: z.string().min(1),
  email: z.email(),
  phone_number: z.string().min(10),
});

export const clinicSchema = z.object({
  name: z.string().min(1),
  logo: z.string().optional().nullable(),
  operatingCountry: countryCodeSchema,
  defaultCurrency: z.enum(CurrencyCode).optional(),
  subscriptionPlan: z.enum(SubscriptionPlan),
  contactPhone: z.string(),
  contactEmail: z.email(),
  admin: adminSchema,
  expiryDate: z.any().optional(),
});

export const updateClinicSchema = z.object({
  name: z.string().min(1),
  logo: z.string().optional().nullable(),
  operatingCountry: countryCodeSchema,
  defaultCurrency: z.enum(CurrencyCode).optional(),
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

export const updateClinicSettingsSchema = z.object({
  isQueueManagementEnabled: z.boolean().optional(),
  defaultCurrency: z.enum(CurrencyCode).optional(),
  isSmsEnabled: z.boolean().optional(),
  smsOnQueueJoined: z.boolean().optional(),
  smsOnQueueTurn: z.boolean().optional(),
  smsOnLabResultsReady: z.boolean().optional(),
  smsOnVisitCompletion: z.boolean().optional(),
});

export type UpdateClinicSchema = z.infer<typeof updateClinicSchema>;
export type UpdateClinicAdminSchema = z.infer<typeof updateClinicAdminSchema>;
