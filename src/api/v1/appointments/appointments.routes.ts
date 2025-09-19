import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";
import {
  cancelAppointment,
  createEvent,
  getDoctorAppointments,
  getDoctorAppointmentsPublic,
  getDoctorAvailability,
  getDoctorWeeklySchedule,
  listAppointments,
  markAppointmentAsCompleted,
  updateDoctorAvailability,
} from "./appointments.controller.ts";
import {
  eventSchema,
  getDoctorAppointmentsParamsSchema,
  getDoctorAvailabilityParamsSchema,
  getWeeklyScheduleParamsSchema,
  scheduleSchema,
} from "./appointments.validation.ts";

const router = new Hono<AppEnv>();

// Availability
router.get(
  "/availability",
  validate(getDoctorAvailabilityParamsSchema, "query"),
  getDoctorAvailability
);
router.put(
  "/doctors/:doctorId/schedule",
  validate(scheduleSchema, "json"),
  updateDoctorAvailability
);
router.get(
  "/doctors/:doctorId/schedule",
  validate(getWeeklyScheduleParamsSchema, "param"),
  getDoctorWeeklySchedule
);

// Events/Appointments
router.post("/events", validate(eventSchema, "json"), createEvent);
router.get(
  "/doctor-appointments",
  validate(getDoctorAppointmentsParamsSchema, "query"),
  getDoctorAppointments
);
router.get(
  "/doctor-appointments-public",
  validate(getDoctorAppointmentsParamsSchema, "query"),
  getDoctorAppointmentsPublic
);
router.get("/", listAppointments);
router.post("/:id/complete", markAppointmentAsCompleted);
router.post("/:id/cancel", cancelAppointment);

export default router;
