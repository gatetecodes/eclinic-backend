import { z } from "zod";

const PER_PAGE_DEFAULT = 20;

export const searchParamsSchema = z.object({
  page: z.coerce.number().default(1),
  per_page: z.coerce.number().default(PER_PAGE_DEFAULT),
  sort: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  careStage: z.string().optional(),
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
  includeWeeklyTimesheet: z.string().optional(),
  weekStart: z.string().optional(),
  deductedOnly: z.preprocess((val) => {
    if (val === "true") {
      return true;
    }
    if (val === "false") {
      return false;
    }
    return val;
  }, z.boolean().optional()),
  claimStatus: z
    .string()
    .optional()
    .refine(
      (val) => {
        if (!val) {
          return true;
        }
        const allowed = [
          "PENDING",
          "SUBMITTED",
          "IN_REVIEW",
          "APPROVED",
          "PAID",
          "PARTIALLY_APPROVED",
          "REJECTED",
          "RESUBMITTED",
        ];
        return val.split(".").every((v) => allowed.includes(v));
      },
      { message: "Invalid claim status" }
    ),
});

export const validateIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type ParamsSchema = z.infer<typeof searchParamsSchema>;
