import { z } from "zod";

export const listInventoryQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  search: z.string().optional(),
  category: z.string().optional(),
});

export type ListInventoryQuery = z.infer<typeof listInventoryQuerySchema>;
