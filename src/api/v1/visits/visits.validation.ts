import { z } from "zod";
import { PaymentMode, Priority } from "../../../../generated/prisma/client";

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
  height: z.string().optional(),
  weight: z.string().optional(),
  temperature: z.string().optional(),
  bloodType: z.string().optional(),
  heartRate: z.string().optional(),
  bloodPressure: z.string().optional(),
  bloodSugar: z.string().optional(),
  respiratory: z.string().optional(),
  hemoglobin: z.string().optional(),
  // Sano triage vitals: oxygen saturation + derived BMI.
  spo2: z.string().optional(),
  bmi: z.string().optional(),
});
export const patientSchema = z
  .object({
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
    foreignerRegion: z
      .enum(["EAST_AFRICA", "AFRICA", "REST_OF_THE_WORLD"])
      .nullable()
      .optional(),
    isChild: z.boolean().optional().default(false),
  })
  .superRefine((data, ctx) => {
    if (data.isAForeigner === true && !data.foreignerRegion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Foreigner region is required for foreign patients",
        path: ["foreignerRegion"],
      });
    } else if (data.isAForeigner !== true && data.foreignerRegion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Foreigner region should not be set for non-foreign patients",
        path: ["foreignerRegion"],
      });
    }
  });

export const insuranceSchema = z.object({
  insuranceNumber: z.string().optional(),
  insuranceCompany: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (Array.isArray(v) ? v[0] : v)),
  employer: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (Array.isArray(v) ? v[0] : v)),
  coveragePercentage: z.string().optional(),
  relationshipType: z
    .enum(["PRINCIPAL", "SPOUSE", "CHILD", "OTHER"])
    .optional()
    .default("PRINCIPAL"),
  principalName: z.string().optional(),
  principalPhoneNumber: z.string().optional(),
});

const validatePhoneNumber = (
  value: string | undefined,
  ctx: z.RefinementCtx,
  path: ["phoneNumber"] | ["guardianPhoneNumber"],
  missingMessage: string
) => {
  if (!value) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: missingMessage,
      path,
    });
    return;
  }

  const validation = phoneSchema.safeParse(value);
  if (!validation.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: validation.error.issues[0]?.message ?? "Invalid phone number",
      path,
    });
  }
};

export const initialCheckInSchema = z
  .object({
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
        foreignerRegion: z
          .enum(["EAST_AFRICA", "AFRICA", "REST_OF_THE_WORLD"])
          .nullable()
          .optional(),
        address: z.string().optional(),
      })
      .superRefine((data, ctx) => {
        if (data.isAForeigner === true && !data.foreignerRegion) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Foreigner region is required for foreign patients",
            path: ["foreignerRegion"],
          });
        } else if (data.isAForeigner !== true && data.foreignerRegion) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "Foreigner region should not be set for non-foreign patients",
            path: ["foreignerRegion"],
          });
        }
      })
      .superRefine((data, ctx) => {
        if (!data.isChild) {
          return;
        }

        validatePhoneNumber(
          data.guardianPhoneNumber,
          ctx,
          ["guardianPhoneNumber"],
          "Guardian's phone number is required for children"
        );
      })
      .superRefine((data, ctx) => {
        if (data.isChild) {
          return;
        }

        validatePhoneNumber(
          data.phoneNumber,
          ctx,
          ["phoneNumber"],
          "Patient phone number is required"
        );
      }),
    chiefComplaint: z.string().optional(),
    departmentId: z.string().optional(),
    priority: z.nativeEnum(Priority),
    selectedPatientId: z.string().optional(),
    isLabOnly: z.boolean().optional().default(false),
    // Step 2: new fields
    doctorId: z.string().optional(),
    requiresConsultation: z.boolean().default(true),
    consultationProductIds: z.array(z.string()).default([]),
    labProductIds: z.array(z.string()).default([]),
    paymentMode: z.string().optional(),
    allowPartial: z.boolean().optional().default(false),
    insurance: insuranceSchema.optional(),
  })
  //biome-ignore lint/complexity/noExcessiveCognitiveComplexity:<>
  .superRefine((data, ctx) => {
    // Insurance validation
    if (data.paymentMode === "INSURANCE") {
      if (!data.insurance?.insuranceNumber) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Insurance number is required",
          path: ["insurance", "insuranceNumber"],
        });
      }
      if (!data.insurance?.insuranceCompany) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Insurance company is required",
          path: ["insurance", "insuranceCompany"],
        });
      }
      if (!data.insurance?.coveragePercentage) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Coverage percentage is required",
          path: ["insurance", "coveragePercentage"],
        });
      }

      // If relationship type is not PRINCIPAL, require principal name and phone
      if (
        data.insurance?.relationshipType &&
        data.insurance.relationshipType !== "PRINCIPAL"
      ) {
        if (!data.insurance.principalName) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "Principal name is required when patient is not the principal",
            path: ["insurance", "principalName"],
          });
        }
        if (!data.insurance.principalPhoneNumber) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "Principal phone number is required when patient is not the principal",
            path: ["insurance", "principalPhoneNumber"],
          });
        }
      }
    }
  })
  .superRefine((data, ctx) => {
    if (data.isLabOnly && data.requiresConsultation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Lab-only visits cannot require consultation",
        path: ["requiresConsultation"],
      });
    }
  })
  .superRefine((data, ctx) => {
    if (
      !data.isLabOnly &&
      (!data.departmentId || data.departmentId.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Department is required",
        path: ["departmentId"],
      });
    }
  })
  .superRefine((data, ctx) => {
    if (!data.isLabOnly) {
      return;
    }

    if (!data.labProductIds || data.labProductIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one lab product is required for lab-only visits",
        path: ["labProductIds"],
      });
    }
    if (!data.paymentMode || data.paymentMode.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Payment mode is required for lab-only visits",
        path: ["paymentMode"],
      });
    }
  })
  .superRefine((data, ctx) => {
    if (data.isLabOnly || !data.requiresConsultation) {
      return;
    }

    if (!data.doctorId || data.doctorId.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Doctor is required when consultation is required",
        path: ["doctorId"],
      });
    }
    if (
      !data.consultationProductIds ||
      data.consultationProductIds.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one consultation product is required",
        path: ["consultationProductIds"],
      });
    }
    if (!data.paymentMode || data.paymentMode.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Payment mode is required when consultation is required",
        path: ["paymentMode"],
      });
    }
  });

export const updateInitialCheckInSchema = initialCheckInSchema.safeExtend({
  visitId: z.number(),
});

export const preConsultationSchema = z.object({
  vitals: vitalsSchema,
  notes: z.string().optional(),
  chiefComplaint: z.string().optional(),
  // New flow: the nurse assigns the department + doctor at triage before
  // sending the patient to consultation. Optional so the legacy path (which
  // assigns these at reception) is unaffected.
  departmentId: z
    .string()
    .regex(/^\d+$/, "departmentId must be a numeric id")
    .optional(),
  doctorId: z
    .string()
    .regex(/^\d+$/, "doctorId must be a numeric id")
    .optional(),
  // Optional acuity/priority set at triage (Routine/Urgent/Emergency).
  priority: z.nativeEnum(Priority).optional(),
});

export type PreConsultation = z.infer<typeof preConsultationSchema>;

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

// Body schema for requesting exam edit approval (replaces direct edit)
export const requestVisitExamEditBodySchema = z.object({
  exams: z.array(z.string()).nonempty("At least one exam is required"),
  reason: z.string().min(1, "Reason for edit is required"),
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

export const addPaymentMethodSchema = z
  .object({
    paymentMode: z.string().min(1, "Payment mode is required"),
    allowPartial: z.boolean().optional().default(false),
    insurance: insuranceSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.paymentMode === "INSURANCE" && !data.insurance?.insuranceNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Insurance number is required",
        path: ["insurance", "insuranceNumber"],
      });
    }
  });

export const editChiefComplaintSchema = z.object({
  chiefComplaint: z.string().min(1, {
    message: "Chief complaint is required",
  }),
});

export const finalizeVisitSchema = z.object({
  // Diagnosis is captured in the consultation note widget, so it's optional at
  // finalize (already saved).
  diagnosis: z.string().optional(),
  scheduleFollowUp: z.boolean().default(false),
  followUpDate: z.string().optional(),
  // New flow: consultation is selected by the doctor and billed (PENDING) at
  // finalize, then settled at final billing. Optional so the legacy flow (which
  // bills consultation at reception) is unaffected.
  consultationProductIds: z.array(z.string()).optional(),
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

// Slim reception check-in for the new flow: capture patient + payment mode
// only. Department/doctor are assigned at triage; consultation is charged at
// finalize. Isolated from the legacy initialCheckInSchema so that path is
// unaffected.
export const flowCheckInSchema = z
  .object({
    patient: z.object({
      firstName: z.string().min(1, "First name is required"),
      lastName: z.string().min(1, "Last name is required"),
      dateOfBirth: z.string().min(1, "Date of birth is required"),
      gender: z.string().min(1, "Gender is required"),
      isChild: z.boolean().optional().default(false),
      phoneNumber: z.string().optional(),
      guardianPhoneNumber: z.string().optional(),
      isAForeigner: z.boolean().optional(),
      foreignerRegion: z
        .enum(["EAST_AFRICA", "AFRICA", "REST_OF_THE_WORLD"])
        .nullable()
        .optional(),
      address: z.string().optional(),
    }),
    selectedPatientId: z.string().optional(),
    paymentMode: z.nativeEnum(PaymentMode).optional(),
    insurance: insuranceSchema.optional(),
    priority: z.nativeEnum(Priority).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.paymentMode === "INSURANCE") {
      if (!data.insurance?.insuranceNumber) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Insurance number is required",
          path: ["insurance", "insuranceNumber"],
        });
      }
      if (!data.insurance?.insuranceCompany) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Insurance company is required",
          path: ["insurance", "insuranceCompany"],
        });
      }
    }
  });

export type IFlowCheckIn = z.infer<typeof flowCheckInSchema>;

// Advance a visit to a new pipeline stage (drives the visual patient flow).
export const advanceVisitSchema = z.object({
  toStage: z.enum([
    "RECEPTION",
    "TRIAGE",
    "DOCTOR",
    "LAB",
    "PHARMACY",
    "BILLING",
    "DONE",
  ]),
  // Optional provider (doctorId) to assign when moving into the DOCTOR stage.
  providerId: z.number().int().positive().optional(),
  // Optional note recorded with the transition.
  note: z.string().max(2000).optional(),
  // When moving to DONE, mark as discharged-with-prescription instead of plain
  // discharge (UI sets this when a prescription was issued).
  withPrescription: z.boolean().optional(),
});

export type IAdvanceVisit = z.infer<typeof advanceVisitSchema>;

// Update status schema
export const updateVisitStatusSchema = z.object({
  status: z.enum([
    "CHECKED_IN",
    "TRIAGE_COMPLETED",
    "IN_PRE_CONSULTATION",
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
export const updatePreConsultationRequestSchema = preConsultationSchema;

// Additional endpoint-specific schemas
export const consultationNoteSchema = z.object({
  consultationNote: z.string().min(1, "Consultation note is required"),
  // Diagnosis is documented with the consultation note (History / Examination /
  // Assessment + Diagnosis). Optional so the note can be saved progressively.
  diagnosis: z.string().optional(),
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
