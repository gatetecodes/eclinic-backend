import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth";
import {
  cancelAppointment,
  createEvent,
  getDoctorAppointments,
  getDoctorAvailability,
  getDoctorWeeklySchedule,
  listAppointments,
  markAppointmentAsCompleted,
  updateDoctorAvailability,
} from "./appointments.controller.ts";

const router = new Hono<AppEnv>();

// Availability
router.get("/availability", getDoctorAvailability);
router.put("/doctors/:doctorId/schedule", updateDoctorAvailability);
router.get("/doctors/:doctorId/schedule", getDoctorWeeklySchedule);

// Events/Appointments
router.post("/events", createEvent);
router.get("/events", getDoctorAppointments);
router.get("/", listAppointments);
router.post("/:id/complete", markAppointmentAsCompleted);
router.post("/:id/cancel", cancelAppointment);

export default router;
