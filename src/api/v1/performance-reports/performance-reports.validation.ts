import { Role } from "generated/prisma/client";
import { z } from "zod";

export const filterSchema = z.object({
  doctorId: z.string().optional(),
  departmentId: z.string().optional(),
  role: z.enum(Role).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  minVisits: z.coerce.number().int().nonnegative().optional(),
  staffId: z.string().optional(),
});

// Preprocess filters to parse JSON string if it's a string
const preprocessedFilterSchema = z.preprocess((val) => {
  if (typeof val === "string") {
    // Handle empty string or stringified empty object
    if (val === "" || val === "{}") {
      return;
    }
    try {
      const parsed = JSON.parse(val);
      // If parsed result is an empty object, return undefined
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        Object.keys(parsed).length === 0
      ) {
        return;
      }
      return parsed;
    } catch {
      // If parsing fails, return undefined to let validation handle it
      return;
    }
  }
  // If already an object, return as-is
  if (val !== null && val !== undefined) {
    return val;
  }
}, filterSchema.optional());

export const rangeAndFiltersSchema = z.object({
  dateRange: z.enum(["today", "week", "month", "quarter", "year", "custom"]),
  filters: preprocessedFilterSchema,
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
