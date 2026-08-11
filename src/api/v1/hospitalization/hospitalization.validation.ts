import z from "zod";
import {
  AdmissionSource,
  AdmissionStatus,
  BedClass,
  BedStatus,
  DischargeDestination,
  MedicationRoute,
  ProgressNoteType,
  WardOrderCategory,
  WardOrderStatus,
  WardType,
} from "../../../../generated/prisma/client";

export const createWardSchema = z.object({
  name: z.string().min(1),
  wardType: z.nativeEnum(WardType).default(WardType.GENERAL),
  accent: z.string().optional(),
  dailyRate: z.coerce.number().positive(),
  bedCount: z.coerce.number().int().min(0).optional(),
});

export const updateWardSchema = z.object({
  name: z.string().min(1).optional(),
  wardType: z.nativeEnum(WardType).optional(),
  accent: z.string().optional(),
  dailyRate: z.coerce.number().positive().optional(),
});

export const addBedsSchema = z.object({
  count: z.coerce.number().int().min(1).max(60),
  class: z.nativeEnum(BedClass).optional(),
  dailyRate: z.coerce.number().positive().optional(),
});

export const updateBedSchema = z.object({
  status: z.nativeEnum(BedStatus),
});

export const admitSchema = z
  .object({
    visitId: z.coerce.number().int().positive().optional(),
    patientId: z.coerce.number().int().positive().optional(),
    wardId: z.coerce.number().int().positive(),
    bedId: z.coerce.number().int().positive().optional(),
    attendingId: z.coerce.number().int().positive().optional(),
    status: z.nativeEnum(AdmissionStatus).optional(),
    source: z.nativeEnum(AdmissionSource).optional(),
    presentingComplaint: z.string().optional(),
    admittingDiagnosis: z.string().optional(),
    admittingIcdCode: z.string().optional(),
    estimatedStayDays: z.coerce.number().int().positive().optional(),
    isRoomCoveredByInsurance: z.boolean().optional(),
  })
  .refine((v) => v.visitId || v.patientId, {
    message: "Either visitId or patientId is required",
    path: ["visitId"],
  });

export const transferSchema = z.object({
  wardId: z.coerce.number().int().positive().optional(),
  bedId: z.coerce.number().int().positive().optional(),
  reason: z.string().optional(),
});

export const observationSchema = z.object({
  temperature: z.string().optional(),
  heartRate: z.string().optional(),
  bloodPressure: z.string().optional(),
  respiratoryRate: z.string().optional(),
  spo2: z.string().optional(),
  pain: z.coerce.number().int().min(0).max(10).optional(),
  avpu: z.string().optional(),
});

export const medicationSchema = z.object({
  drugName: z.string().min(1),
  productId: z.coerce.number().int().positive().optional(),
  dose: z.string().min(1),
  route: z.nativeEnum(MedicationRoute),
  frequency: z.string().min(1),
  firstDoseAt: z.string().optional(),
  pricePerDose: z.coerce.number().min(0),
  doseValue: z.coerce.number().positive().optional(),
  doseUnit: z.string().trim().min(1).max(50).optional(),
  frequencyCount: z.coerce.number().int().positive().optional(),
  frequencyPeriod: z.coerce.number().positive().optional(),
  frequencyPeriodUnit: z.enum(["s", "min", "h", "d", "wk", "mo"]).optional(),
  routeSystem: z.string().trim().min(1).max(500).optional(),
  routeCode: z.string().trim().min(1).max(120).optional(),
  routeDisplay: z.string().trim().min(1).max(300).optional(),
  methodSystem: z.string().trim().min(1).max(500).optional(),
  methodCode: z.string().trim().min(1).max(120).optional(),
  methodDisplay: z.string().trim().min(1).max(300).optional(),
  durationValue: z.coerce.number().positive().optional(),
  durationUnit: z.enum(["s", "min", "h", "d", "wk", "mo"]).optional(),
});

export const administerSchema = z.object({
  administrationId: z.coerce.number().int().positive().optional(),
});

export const progressNoteSchema = z.object({
  noteType: z.nativeEnum(ProgressNoteType).optional(),
  text: z.string().min(1),
});

export const orderSchema = z.object({
  investigation: z.string().min(1),
  category: z.nativeEnum(WardOrderCategory).optional(),
  price: z.coerce.number().min(0).optional(),
});

export const updateOrderSchema = z.object({
  status: z.nativeEnum(WardOrderStatus).optional(),
  result: z.string().optional(),
  resultSeverity: z.string().optional(),
});

export const dischargeSchema = z.object({
  finalDiagnosis: z.string().optional(),
  summary: z.string().optional(),
  followUpDate: z.string().optional(),
  destination: z.nativeEnum(DischargeDestination).optional(),
  patientInstructions: z.string().optional(),
});
