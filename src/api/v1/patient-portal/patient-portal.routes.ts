import { Hono } from "hono";
import type { AppEnv } from "@/middlewares/auth.middleware.ts";
import { validate } from "@/middlewares/validation.middleware.ts";
import {
  bookPatientAppointment,
  cancelPatientAppointment,
  getAppointmentDetails,
  getAvailableBranches,
  getAvailableClinics,
  getAvailableDepartments,
  getAvailableDoctors,
  getDoctorAvailableDays,
  getDoctorAvailableSlots,
  getDoctorAvailableTimeSlots,
  getPatientAppointments,
} from "./appointments.controller.ts";
import {
  bookPatientAppointmentSchema,
  cancelPatientAppointmentParamsSchema,
  getAppointmentDetailsParamsSchema,
  getAvailableBranchesParamsSchema,
  getAvailableDepartmentsParamsSchema,
  getAvailableDoctorsParamsSchema,
  getDoctorAvailableDaysParamsSchema,
  getDoctorAvailableSlotsParamsSchema,
  getDoctorAvailableTimeSlotsParamsSchema,
  getPatientAppointmentsParamsSchema,
} from "./patient-portal.validations.ts";

const router = new Hono<AppEnv>();

router.get("/clinics", getAvailableClinics);
router.get(
  "/branches",
  validate(getAvailableBranchesParamsSchema, "param"),
  getAvailableBranches
);
router.get(
  "/departments",
  validate(getAvailableDepartmentsParamsSchema, "param"),
  getAvailableDepartments
);
router.get(
  "/doctors",
  validate(getAvailableDoctorsParamsSchema, "param"),
  getAvailableDoctors
);
router.get(
  "/appointments",
  validate(getPatientAppointmentsParamsSchema, "param"),
  getPatientAppointments
);

router.get(
  "/appointments/:appointmentId",
  validate(getAppointmentDetailsParamsSchema, "param"),
  getAppointmentDetails
);
router.post(
  "/appointments",
  validate(bookPatientAppointmentSchema, "json"),
  bookPatientAppointment
);
router.put(
  "/appointments/:appointmentId",
  validate(cancelPatientAppointmentParamsSchema, "param"),
  cancelPatientAppointment
);
router.get(
  "/doctors/:doctorId/available-days",
  validate(getDoctorAvailableDaysParamsSchema, "param"),
  getDoctorAvailableDays
);
router.get(
  "/doctors/:doctorId/available-time-slots",
  validate(getDoctorAvailableTimeSlotsParamsSchema, "param"),
  getDoctorAvailableTimeSlots
);
router.get(
  "/doctors/:doctorId/available-slots",
  validate(getDoctorAvailableSlotsParamsSchema, "param"),
  getDoctorAvailableSlots
);
router.get(
  "/doctors/:doctorId/available-days",
  validate(getDoctorAvailableDaysParamsSchema, "param"),
  getDoctorAvailableDays
);
router.get(
  "/doctors/:doctorId/available-time-slots",
  validate(getDoctorAvailableTimeSlotsParamsSchema, "param"),
  getDoctorAvailableTimeSlots
);
router.get(
  "/doctors/:doctorId/available-slots",
  validate(getDoctorAvailableSlotsParamsSchema, "param"),
  getDoctorAvailableSlots
);

export default router;
