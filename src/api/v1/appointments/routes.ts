import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth";
import * as AppointmentsController from "./appointments.controller.ts";

const router = new Hono<AppEnv>();

// Availability
router.get("/availability", AppointmentsController.getDoctorAvailability);
router.put(
  "/doctors/:doctorId/schedule",
  AppointmentsController.updateDoctorAvailability,
);
router.get(
  "/doctors/:doctorId/schedule",
  AppointmentsController.getDoctorWeeklySchedule,
);

// Events/Appointments
router.post("/events", AppointmentsController.createEvent);
router.get("/events", AppointmentsController.getDoctorAppointments);
router.get("/", AppointmentsController.listAppointments);
router.post("/:id/complete", AppointmentsController.markAppointmentAsCompleted);
router.post("/:id/cancel", AppointmentsController.cancelAppointment);

export default router;
