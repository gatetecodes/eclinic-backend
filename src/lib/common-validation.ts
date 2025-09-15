import * as z from "zod";
export const searchParamsSchema = z.object({
  page: z.coerce.number().default(1),
  per_page: z.coerce.number().default(20),
  sort: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  type: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  lastCursor: z.string().optional(),
  operator: z.enum(["and", "or"]).optional(),
  title: z.string().optional(),
  role: z.string().optional(),
  gender: z.string().optional(),
  patient: z.string().optional(),
  doctorId: z.string().optional(),
  clinicId: z.string().optional(),
  itemName: z.string().optional(),
  itemType: z.string().optional(),
  branchId: z.string().optional(),
  insuranceCompany: z.string().optional(),
  processedById: z.string().optional(),
});

export type ParamsSchema = z.infer<typeof searchParamsSchema>;
