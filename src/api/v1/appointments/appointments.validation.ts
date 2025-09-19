import { EventType } from "@prisma/client";
import { z } from "zod";
import { patientSchema } from "../visits/visits.validation";

const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const scheduleSchema = z
  .array(
    z.object({
      dayOfWeek: z.number().min(0).max(6),
      startTime: z.string().regex(timeRegex, "Invalid time format. Use HH:mm"),
      endTime: z.string().regex(timeRegex, "Invalid time format. Use HH:mm"),
    })
  )
  .refine(
    (schedule) => {
      return schedule.every((slot) => slot.endTime > slot.startTime);
    },
    {
      message: "End time must be after start time for all slots",
    }
  );

export const eventSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal(EventType.APPOINTMENT),
      title: z.string().optional(),
      description: z.string().optional(),
      startTime: z.coerce.date(),
      endTime: z.coerce.date(),
      patient: patientSchema,
      treatment: z.string(),
      doctorId: z.coerce.number(),
      clinicId: z.coerce.number().optional(),
    }),
    z.object({
      type: z.enum([EventType.MEETING, EventType.TASK, EventType.OTHER]),
      title: z.string(),
      description: z.string().optional(),
      startTime: z.coerce.date(),
      endTime: z.coerce.date(),
      doctorId: z.coerce.number(),
      clinicId: z.coerce.number().optional(),
    }),
  ])
  .refine((event) => event.startTime < event.endTime, {
    message: "End time must be after start time",
    path: ["endTime"],
  });

export const getDoctorAppointmentsParamsSchema = z.object({
  doctorId: z.coerce.number(),
  startDate: z.coerce.date().optional(),
});

export const getDoctorAvailabilityParamsSchema = z.object({
  doctorId: z.coerce.number(),
  date: z.coerce.date(),
});

export const getWeeklyScheduleParamsSchema = z.object({
  doctorId: z.coerce.number(),
});

export type GetDoctorAvailabilityParams = z.infer<
  typeof getDoctorAvailabilityParamsSchema
>;

export type GetDoctorAppointmentsParams = z.infer<
  typeof getDoctorAppointmentsParamsSchema
>;
