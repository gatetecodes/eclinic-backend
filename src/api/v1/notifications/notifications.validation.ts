import { z } from "zod";

export const notificationSchema = z.object({
  userId: z.number(),
  title: z.string(),
  message: z.string(),
  type: z.enum([
    "APPROVAL_REQUEST",
    "APPOINTMENT_REMINDER",
    "VISIT_UPDATE",
    "PAYMENT_CONFIRMATION",
    "SYSTEM_UPDATE",
    "INVENTORY_ALERT",
    "NEW_PAYMENT_BILL",
    "LAB_EXAM_RESULTS",
    "LAB_EXAM_REQUEST",
    "HANDOFF_REQUEST",
  ]),
});
