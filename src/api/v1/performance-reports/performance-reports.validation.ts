import { Role } from "generated/prisma";
import { z } from "zod";

export const filterSchema = z.object({
  doctorId: z.string().optional(),
  departmentId: z.string().optional(),
  role: z.enum(Role).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  minVisits: z.number().optional(),
});

export const rangeAndFiltersSchema = z.object({
  dateRange: z.enum(["today", "week", "month", "quarter", "year", "custom"]),
  filters: filterSchema,
});

export const detailedVisitsSchema = rangeAndFiltersSchema.extend({
  metricType: z.enum(["all", "completed"]),
  page: z.number().optional(),
  pageSize: z.number().optional(),
});

export const detailedExamsSchema = rangeAndFiltersSchema.extend({
  page: z.number().optional(),
  pageSize: z.number().optional(),
});
