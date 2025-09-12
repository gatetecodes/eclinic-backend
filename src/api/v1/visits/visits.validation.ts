import { z } from "zod";

export const listVisitsQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.string().optional(),
  doctorId: z.string().optional(),
  patientId: z.string().optional(),
});

export const getVisitParamsSchema = z.object({ id: z.string() });

export type ListVisitsQuery = z.infer<typeof listVisitsQuerySchema>;
export type GetVisitParams = z.infer<typeof getVisitParamsSchema>;
