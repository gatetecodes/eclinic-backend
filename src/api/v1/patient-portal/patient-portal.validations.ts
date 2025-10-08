import { z } from "zod";

export const getPatientAppointmentsParamsSchema = z.object({
  patientId: z.string(),
});

export const getAppointmentDetailsParamsSchema = z.object({
  appointmentId: z.string(),
  patientId: z.string(),
});

export const cancelPatientAppointmentParamsSchema = z.object({
  appointmentId: z.string(),
  patientId: z.string(),
});

export const getDoctorAvailableDaysParamsSchema = z.object({
  doctorId: z.string(),
});

export const getDoctorAvailableTimeSlotsParamsSchema = z.object({
  doctorId: z.string(),
  dayOfWeek: z.string(),
});

export const getDoctorAvailableSlotsParamsSchema = z.object({
  doctorId: z.string(),
  date: z.string(),
});

export const getAvailableBranchesParamsSchema = z.object({
  clinicId: z.string(),
});

export const getAvailableDepartmentsParamsSchema = z.object({
  clinicId: z.string(),
  branchId: z.string().optional(),
});

export const getAvailableDoctorsParamsSchema = z.object({
  clinicId: z.string(),
  departmentId: z.string().optional(),
  branchId: z.string().optional(),
});

export const bookPatientAppointmentSchema = z.object({
  patientId: z.string(),
  clinicId: z.string(),
  branchId: z.string().optional(),
  departmentId: z.string(),
  doctorId: z.string(),
  appointmentDate: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  reason: z.string().optional(),
  symptoms: z.string().optional(),
  isFollowUp: z.boolean().default(false),
  previousVisitId: z.string().optional(),
});
