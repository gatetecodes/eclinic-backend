import { Role } from "generated/prisma";
import { z } from "zod";

export const filterSchema = z.object({
  doctorId: z.string().optional(),
  departmentId: z.string().optional(),
  role: z.enum(Role).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  minVisits: z.coerce.number().int().nonnegative().optional(),
  staffId: z.coerce.number().int().positive().optional(),
});

export const rangeAndFiltersSchema = z.object({
  dateRange: z.enum(["today", "week", "month", "quarter", "year", "custom"]),
  filters: filterSchema,
});

export const detailedVisitsSchema = rangeAndFiltersSchema.extend({
  metricType: z.enum(["all", "completed"]),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(10),
});

export const detailedExamsSchema = rangeAndFiltersSchema.extend({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(10),
});

export const getTopPerformersSchema = rangeAndFiltersSchema.extend({
  limit: z.coerce.number().int().positive().max(100).default(10),
});
