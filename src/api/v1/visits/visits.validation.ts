import { Priority } from "@prisma/client";
import { z } from "zod";

const RWANDAN_PHONE_PATTERN = /^(\+?250|0)?7[2389][0-9]{7}$/;
const INTERNATIONAL_PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;

// Define a reusable phone number validation schema
const phoneSchema = z.string().refine(
  (value) => {
    // Allow empty strings since the schema handles required/optional separately
    if (!value) {
      return true;
    }

    // Check for Rwandan numbers
    if (RWANDAN_PHONE_PATTERN.test(value)) {
      return true;
    }

    // Check for international format (E.164)
    // Allows + followed by 7-15 digits
    return INTERNATIONAL_PHONE_PATTERN.test(value);
  },
  {
    message:
      "Invalid phone number format. Must be a valid Rwandan number or international format (e.g. +12345678901)",
  }
);

export const vitalsSchema = z.object({
  bloodType: z.string().optional(),
  heartRate: z.string().optional(),
  bloodPressure: z.string().optional(),
  bloodSugar: z.string().optional(),
  respiratory: z.string().optional(),
  hemoglobin: z.string().optional(),
});
export const patientSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  dateOfBirth: z.string(),
  gender: z.string(),
  phoneNumber: z.string().optional(),
  guardianPhoneNumber: z.string().optional(),
  email: z.string().optional(),
  address: z.string().optional(),
  medicalInfo: vitalsSchema.optional(),
  nationality: z.string().optional(),
  isAForeigner: z.boolean().optional(),
});

export const initialCheckInSchema = z.object({
  patient: z
    .object({
      firstName: z.string().min(1, "First name is required"),
      lastName: z.string().min(1, "Last name is required"),
      dateOfBirth: z.string().min(1, "Date of birth is required"),
      gender: z.string().min(1, "Gender is required"),
      isChild: z.boolean().optional().default(false),
      phoneNumber: z.string().optional(),
      guardianPhoneNumber: z.string().optional(),
      isAForeigner: z.boolean().optional(),
    })
    .superRefine((data, ctx) => {
      if (data.isChild) {
        if (!data.guardianPhoneNumber) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Guardian's phone number is required for children",
            path: ["guardianPhoneNumber"],
          });
          return;
        }
        const guardianValidation = phoneSchema.safeParse(
          data.guardianPhoneNumber
        );
        if (!guardianValidation.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              guardianValidation.error.issues[0]?.message ??
              "Invalid phone number",
            path: ["guardianPhoneNumber"],
          });
        }
        return;
      }

      if (!data.phoneNumber) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Patient phone number is required",
          path: ["phoneNumber"],
        });
        return;
      }
      const patientValidation = phoneSchema.safeParse(data.phoneNumber);
      if (!patientValidation.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            patientValidation.error.issues[0]?.message ??
            "Invalid phone number",
          path: ["phoneNumber"],
        });
      }
    }),
  basicTriage: z.object({
    height: z.string().optional(),
    weight: z.string().optional(),
    temperature: z.string().optional(),
  }),
  chiefComplaint: z.string().optional(),
  departmentId: z.string().min(1, "Department is required"),
  priority: z.nativeEnum(Priority),
  isLabOnly: z.boolean().optional().default(false),
});

export type IInitialCheckIn = z.infer<typeof initialCheckInSchema>;

export const preConsultationSchema = z
  .object({
    vitals: vitalsSchema,
    doctorId: z.string().min(1, "Doctor is required"),
    requiresConsultation: z.boolean().default(true),
    consultationProductIds: z.array(z.string()).optional(),
    notes: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.requiresConsultation && !data.consultationProductIds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Consultation product is required",
      });
    }
  });

export type PreConsultation = z.infer<typeof preConsultationSchema>;

export const insuranceSchema = z.object({
  insuranceNumber: z.string().min(1, "Insurance number is required"),
  insuranceCompany: z.string().min(1, "Insurance company is required"),
  employer: z.string().optional(),
  coveragePercentage: z.string().min(1, "Coverage percentage is required"),
});

export const visitSchema = z.object({
  patient: patientSchema,
  departmentId: z.string(),
  doctorId: z.string(),
  notes: z.string().optional(),
});

export const addExamsSchema = z.object({
  title: z.string().optional(),
  visitId: z.string(),
  exams: z.array(z.string()).nonempty("At least one exam is required"),
});

export const editExamsSchema = z.object({
  visitId: z.string(),
  departmentIds: z.array(z.string()).optional(),
  exams: z.array(z.string()).nonempty("At least one exam is required"),
});

export const addTreatmentSchema = z.object({
  visitId: z.string(),
  departmentId: z.string().optional(),
  treatments: z
    .array(z.string())
    .nonempty("At least one treatment is required"),
});

export const addNurseTreatmentSchema = z.object({
  visitId: z.string(),
  treatments: z
    .array(
      z.object({
        id: z.string(),
        quantity: z.string(),
      })
    )
    .nonempty("At least one treatment is required"),
});

export const addPaymentMethodSchema = z.object({
  paymentMode: z.string().min(1, "Payment mode is required"),
  insurance: z.union([insuranceSchema, z.object({}).strict(), z.undefined()]),
});

export const editChiefComplaintSchema = z.object({
  chiefComplaint: z.string().min(1, {
    message: "Chief complaint is required",
  }),
});

export const finalizeVisitSchema = z.object({
  diagnosis: z.string().min(1, "Diagnosis is required"),
  examConclusions: z.string().min(1, "Exam conclusions are required"),
  treatmentComments: z.string().min(1, "Treatment comments are required"),
  scheduleFollowUp: z.boolean().default(false),
  followUpDate: z.string().optional(),
});

export const handoffSchema = z.object({
  visitId: z.number(),
  toDoctorId: z.string().min(1, "Receiving doctor is required"),
  handoffNotes: z.string().min(1, "Handoff notes are required"),
});

export type HandoffFormData = z.infer<typeof handoffSchema>;

export type Visit = z.infer<typeof visitSchema>;
