import { z } from "zod";

export const eventTypeValues = ["APPOINTMENT", "BLOCK", "OTHER"] as const;
export const eventStatusValues = [
  "SCHEDULED",
  "COMPLETED",
  "CANCELLED",
] as const;

export const eventSchema = z.object({
  type: z.enum(eventTypeValues),
  startTime: z.coerce.date(),
  endTime: z.coerce.date(),
  doctorId: z.number().int().positive(),
  title: z.string().optional(),
  description: z.string().optional(),
  patient: z
    .object({
      firstName: z.string(),
      lastName: z.string(),
      phoneNumber: z.string().optional(),
      id: z.number().int().optional(),
    })
    .optional(),
  treatment: z.string().optional(),
});

export type CreateEventInput = z.infer<typeof eventSchema>;

export const scheduleSlotSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
});

export const scheduleSchema = z.array(scheduleSlotSchema).min(1);

export type UpdateScheduleInput = z.infer<typeof scheduleSchema>;
