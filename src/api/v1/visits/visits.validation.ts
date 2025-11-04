import { z } from "zod";
import { Priority } from "../../../../generated/prisma";

const INTERNATIONAL_PHONE_PATTERN = /^\+[1-9]\d{9,14}$/;
const RWANDAN_CORE_PATTERN = /^7[2389][0-9]{7}$/;
const NON_DIGIT_PATTERN = /\D/g;
const RWANDA_PREFIX_PATTERN = /^\+?250/;
const LEADING_ZERO_PATTERN = /^0/;

// Define a reusable phone number validation schema
const phoneSchema = z.string().refine(
  (value) => {
    // Allow empty strings since the schema handles required/optional separately
    if (!value) {
      return true;
    }

    // Remove all non-digit characters for length checking
    const digitsOnly = value.replace(NON_DIGIT_PATTERN, "");

    // Enforce minimum length - phone numbers should be at least 9 digits
    if (digitsOnly.length < 9) {
      return false;
    }

    // Check for Rwandan numbers first
    // Format: +250712345678 or 250712345678 or 0712345678 or 712345678
    // The core number must be exactly 9 digits: 7[2389] followed by 7 more digits

    // Extract just the 9-digit core number (remove country code/prefix)
    // Remove +250 or 250 prefix first
    let normalized = value.replace(RWANDA_PREFIX_PATTERN, "");
    // Remove leading 0 if present
    normalized = normalized.replace(LEADING_ZERO_PATTERN, "");
    // Remove all non-digit characters to get just the core digits
    const coreDigits = normalized.replace(NON_DIGIT_PATTERN, "");

    // If it starts with +250 or 250, it must be a valid Rwandan number
    // Don't allow it to fall through to international validation
    const isRwandanPrefix = RWANDA_PREFIX_PATTERN.test(value);

    // Must have exactly 9 digits matching the Rwandan pattern
    if (coreDigits.length === 9 && RWANDAN_CORE_PATTERN.test(coreDigits)) {
      return true;
    }

    // If it has Rwandan prefix but doesn't match, reject it (don't check international)
    if (isRwandanPrefix) {
      return false;
    }

    // Check for international format (E.164) - only for non-Rwandan numbers
    // Must start with + and have at least 10 digits total (country code + number)
    // Maximum 15 digits per E.164 standard
    // Pattern: + followed by country code (1-3 digits, first digit 1-9) then number (at least 6 digits)
    if (value.startsWith("+")) {
      // Normalize: build a string with '+' followed by only digits
      const normalizedInternational = `+${digitsOnly}`;
      if (
        INTERNATIONAL_PHONE_PATTERN.test(normalizedInternational) &&
        digitsOnly.length >= 10 &&
        digitsOnly.length <= 15
      ) {
        return true;
      }
    }

    return false;
  },
  {
    message:
      "Invalid phone number format. Must be a valid Rwandan number (9 digits) or international format (minimum 10 digits with country code)",
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
  isChild: z.boolean().optional().default(false),
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
      address: z.string().optional(),
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

export const updateInitialCheckInSchema = initialCheckInSchema.extend({
  visitId: z.number(),
});

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

// Body schema for editing exams via route param id
export const editVisitExamsBodySchema = z.object({
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

// Params schemas
export const getVisitParamsSchema = z.object({ id: z.string() });

// Handoff route params and bodies
export const getHandoffParamsSchema = z.object({ handoffId: z.string() });
export const rejectHandoffBodySchema = z.object({
  reason: z.string().min(1, "Rejection reason is required"),
});

// Update status schema
export const updateVisitStatusSchema = z.object({
  status: z.enum([
    "CHECKED_IN",
    "TRIAGE_COMPLETED",
    "IN_CONSULTATION",
    "PENDING_TESTS",
    "RESULTS_READY",
    "FINALIZED",
    "DISCHARGED",
    "DISCHARGED_WITH_PRESCRIPTION",
    "ADMITTED",
    "CANCELLED",
  ]),
});

// Request schemas for controller endpoints
export const updatePreConsultationRequestSchema =
  preConsultationSchema.safeExtend({
    patientId: z.coerce.number(),
  });

// Additional endpoint-specific schemas
export const consultationNoteSchema = z.object({
  consultationNote: z.string().min(1, "Consultation note is required"),
});

export const addVisitTreatmentBodySchema = z.object({
  treatments: z
    .array(z.string())
    .nonempty("At least one treatment is required"),
});

export const addVisitNurseTreatmentBodySchema = z.object({
  treatments: z
    .array(
      z.object({
        id: z.string(),
        quantity: z.string(),
      })
    )
    .nonempty("At least one treatment is required"),
  allowPartial: z.boolean().optional().default(false),
});

export const getPatientVisitsParamsSchema = z.object({ patientId: z.string() });

export const transferVisitToDoctorSchema = z.object({
  doctorId: z.string().min(1, "Doctor is required"),
});

export const getPatientByPhoneSchema = z

  .object({
    phone: z.string().min(1, "Phone number is required"),
  })
  .superRefine((data, ctx) => {
    const validation = phoneSchema.safeParse(data.phone);

    if (!validation.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          validation.error.issues[0]?.message ??
          "Invalid phone number format. Must be a valid Rwandan number or international format (e.g. +12345678901)",
        path: ["phone"],
      });
    }
  })
  .transform(({ phone }) => phone);

export const createPrescriptionSchema = z.object({
  prescription: z.object({
    items: z.array(
      z.object({
        medicationName: z.string(),
        dosage: z.string(),
        frequency: z.string(),
        duration: z.string(),
        instructions: z.string().optional(),
      })
    ),
  }),
  visitId: z.number(),
  doctorId: z.number(),
  followUpAppointment: z
    .object({
      startTime: z.union([z.string(), z.date()]),
      endTime: z.union([z.string(), z.date()]),
      treatment: z.string(),
    })
    .optional(),
});

export type CreatePrescription = z.infer<typeof createPrescriptionSchema>;

export const updatePrescriptionSchema = z.object({
  items: z.array(
    z.object({
      id: z.number(),
      medicationName: z.string(),
      dosage: z.string(),
      frequency: z.string(),
      duration: z.string(),
      instructions: z.string().optional(),
    })
  ),
});

export type UpdatePrescription = z.infer<typeof updatePrescriptionSchema>;

export const spectaclePrescriptionSchema = z.object({
  rightEye: z.object({
    distant: z.object({
      sphere: z.string().optional(),
      cylinder: z.string().optional(),
      axis: z.string().optional(),
    }),
    near: z.string().optional(),
  }),
  leftEye: z.object({
    distant: z.object({
      sphere: z.string().optional(),
      cylinder: z.string().optional(),
      axis: z.string().optional(),
    }),
    near: z.string().optional(),
  }),
  interpupillaryDistance: z.object({
    distant: z.string().optional(),
    near: z.string().optional(),
    add: z.string().optional(),
  }),
  lensType: z
    .array(
      z.enum([
        "Unifocal",
        "Anti-blue light",
        "Progressive",
        "Organic",
        "Clear",
        "Photochromic",
        "Bifocal",
        "Mineral",
        "Reading",
        "Tinting",
      ])
    )
    .optional(),
});

export const createSpectaclePrescriptionSchema = z.object({
  prescription: spectaclePrescriptionSchema,
  visitId: z.string(),
  doctorId: z.string(),
});

export const updateSpectaclePrescriptionSchema = z.object({
  prescription: spectaclePrescriptionSchema,
});

export const getPrescriptionParamsSchema = z.object({
  prescriptionId: z.string(),
});

export type IInitialCheckIn = z.infer<typeof initialCheckInSchema>;
export type IUpdateInitialCheckIn = z.infer<typeof updateInitialCheckInSchema>;
export type CreateSpectaclePrescription = z.infer<
  typeof createSpectaclePrescriptionSchema
>;
export type UpdateSpectaclePrescription = z.infer<
  typeof updateSpectaclePrescriptionSchema
>;
