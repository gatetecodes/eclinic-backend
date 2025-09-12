import { z } from "zod";

export const listPaymentsQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
});

export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;
