import { z } from "zod";

export const availabilityParamSchema = z.object({
  userId: z.coerce.number().int().positive(),
});

export const availabilityQuerySchema = z.object({
  date: z.coerce.date(),
  branchId: z.coerce.number().int().positive().optional(),
  slotMinutes: z.coerce.number().int().min(5).max(240).optional(),
});

export type AvailabilityParams = z.infer<typeof availabilityParamSchema>;
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
