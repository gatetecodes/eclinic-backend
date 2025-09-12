import { z } from "zod";

export const listPatientsQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  search: z.string().optional(),
});

export type ListPatientsQuery = z.infer<typeof listPatientsQuerySchema>;
