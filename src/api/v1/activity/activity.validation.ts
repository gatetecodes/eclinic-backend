import { z } from "zod";

export const activityTypeValues = [
  "PAYMENT",
  "STATUS_UPDATE",
  "TASK",
  "HOSPITALIZATION",
  "BILL_UPDATE",
  "INSURANCE_CLAIM",
  "INSURANCE_CLAIM_UPDATE",
  "INSURANCE_CLAIM_ITEM",
  "INSURANCE_CLAIM_DOCUMENT",
  "INSURANCE_CLAIM_STATUS_UPDATE",
  "VISIT_DISCHARGED",
  "SPECTACLE_PRESCRIPTION_CREATED",
  "HANDOFF",
] as const;

export const logActivitySchema = z.object({
  visitId: z.number().int().optional(),
  action: z.string().min(1),
  type: z.enum(activityTypeValues),
  duration: z.number().int().positive().optional(),
  eventId: z.number().int().optional(),
});

export const getVisitTimelineParamsSchema = z.object({
  visitId: z.string().regex(/^\d+$/),
});

export type LogActivityInput = z.infer<typeof logActivitySchema>;
export type GetVisitTimelineParams = z.infer<
  typeof getVisitTimelineParamsSchema
>;
