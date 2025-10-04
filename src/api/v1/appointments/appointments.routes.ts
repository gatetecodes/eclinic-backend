import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { crudAccess } from "../../../middlewares/crud-access.middleware.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";
import {
  cancelAppointment,
  createEvent,
  getAppointments,
  getAvailableDaysByDoctorId,
  getAvailableTimeSlotsByDoctorId,
  getDoctorAppointments,
  getDoctorAppointmentsPublic,
  getDoctorAvailability,
  getDoctorWeeklySchedule,
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
router.use("*", crudAccess("appointments", "visits"));

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
router.get("/", getAppointments);
router.post("/:id/complete", markAppointmentAsCompleted);
router.post("/:id/cancel", cancelAppointment);
router.get("/doctors/:doctorId/available-days", getAvailableDaysByDoctorId);
router.get(
  "/doctors/:doctorId/available-time-slots",
  getAvailableTimeSlotsByDoctorId
);

export default router;
