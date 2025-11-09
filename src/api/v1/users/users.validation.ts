import { z } from "zod";

const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

const staffRoles = [
  "RECEPTIONIST",
  "PHARMACIST",
  "LAB_TECHNICIAN",
  "CASHIER",
  "NURSE",
  "STOCK_MANAGER",
  "DOCTOR",
] as const;

const weeklyAvailabilitySchema = z
  .array(
    z
      .object({
        startDayOfWeek: z.coerce.number().min(0).max(6),
        endDayOfWeek: z.coerce.number().min(0).max(6),
        startTime: z
          .string()
          .optional()
          .nullable()
          .transform((val) => val ?? "")
          .pipe(
            z.union([
              z.literal(""),
              z.string().regex(timeRegex, "Time must be in HH:mm format"),
            ])
          ),
        endTime: z
          .string()
          .optional()
          .nullable()
          .transform((val) => val ?? "")
          .pipe(
            z.union([
              z.literal(""),
              z.string().regex(timeRegex, "Time must be in HH:mm format"),
            ])
          ),
      })
      .refine(
        (data) =>
          (data.startTime === "" && data.endTime === "") ||
          (data.startTime !== "" && data.endTime !== ""),
        {
          message: "Both start and end times must be provided, or both empty.",
          path: ["startTime"],
        }
      )
      .refine(
        (data) => {
          if (data.startTime === "" || data.endTime === "") {
            return true;
          }
          if (data.startDayOfWeek === data.endDayOfWeek) {
            return data.endTime > data.startTime;
          }
          return true;
        },
        {
          message: "End time must be after start time on the same day.",
          path: ["endTime"],
        }
      )
  )
  .optional();

export const createUserSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8),
    role: z.enum(staffRoles),
    phone_number: z.string().min(10),
    highestEducation: z.enum(["A0", "A1", "A2"]).optional(),
    // Doctor-specific optional fields
    licenseNumber: z.string().optional(),
    licenseExpiration: z.string().optional(),
    license_document: z.string().optional(),
    diploma_document: z.string().optional(),
    departments: z.array(z.coerce.number()).optional(),
    weeklyAvailability: weeklyAvailabilitySchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.role === "NURSE" && data.highestEducation === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Highest education is required for nurses",
        path: ["highestEducation"],
      });
    }
  });

export const createDoctorSchema = z
  .object({
    name: z.string().min(1),
    email: z.email(),
    password: z.string().min(8),
    role: z.enum(["DOCTOR", "NURSE"]),
    phone_number: z.string().min(10),
    departments: z.array(z.coerce.number()).nonempty(),
    highestEducation: z.enum(["A0", "A1", "A2"]).optional(),
    consultationFee: z.coerce.number().optional(),
    licenseNumber: z.string().optional(),
    licenseExpiration: z.string().optional(),
    license_document: z.string().optional(),
    diploma_document: z.string().optional(),
    weeklyAvailability: weeklyAvailabilitySchema,
  })
  .superRefine((data, ctx) => {
    if (data.role === "NURSE" && data.highestEducation === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Highest education is required for nurses",
        path: ["highestEducation"],
      });
    }
  });

export const editDoctorSchema = createDoctorSchema.partial().extend({
  email: z.string().email(),
});

export const updateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(staffRoles),
  phone_number: z.string().min(10),
  password: z.string().min(8).optional(),
});

export const userIdParamSchema = z.object({
  userId: z.coerce.number().int().positive(),
});

export const doctorIdParamSchema = z.object({
  doctorId: z.coerce.number().int().positive(),
});

export const addDoctorAvailabilitySchema = z.object({
  weeklyAvailability: weeklyAvailabilitySchema,
});

export const assignDepartmentsToDoctorSchema = z.object({
  departments: z.array(z.coerce.number()).nonempty(),
});

export const getAvailableDoctorsByDepartmentIdSchema = z.object({
  departmentId: z.coerce.number().int().positive(),
  date: z.string(),
  includeDoctorId: z.coerce.number().int().positive().optional(),
});

export const staffShiftSchema = z
  .object({
    daysOfWeek: z
      .array(z.coerce.number().int().min(0).max(6))
      .min(1, "At least one day of week must be specified"),
    startTime: z.string().regex(timeRegex, "Time must be in HH:mm format"),
    endTime: z.string().regex(timeRegex, "Time must be in HH:mm format"),
    branchId: z.coerce.number().int().positive().optional().nullable(),
  })
  .refine(
    (s) => {
      // End time must be after start time (handles cross-midnight implicitly via daysOfWeek)
      return s.endTime > s.startTime;
    },
    {
      message: "End time must be after start time",
      path: ["endTime"],
    }
  );

export const scheduleExceptionSchema = z
  .object({
    date: z.coerce.date(),
    isWorking: z.boolean().default(false),
    startTime: z
      .string()
      .regex(timeRegex, "Time must be in HH:mm format")
      .optional()
      .nullable(),
    endTime: z
      .string()
      .regex(timeRegex, "Time must be in HH:mm format")
      .optional()
      .nullable(),
    branchId: z.coerce.number().int().positive().optional().nullable(),
  })
  .refine(
    (e) => {
      if (!e.isWorking) {
        return true;
      }
      return Boolean(e.startTime && e.endTime);
    },
    { message: "Working exceptions must include start and end times" }
  );

const timesheetPeriodSchema = z.enum(["WEEK", "MONTH", "CUSTOM"]);

// Helper to validate date alignment with period type
function validatePeriodDates(
  periodType: "WEEK" | "MONTH" | "CUSTOM",
  startDate: Date,
  endDate: Date
): boolean {
  const diffMs = endDate.getTime() - startDate.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (periodType === "WEEK") {
    // Must be exactly 7 days (or multiples)
    return diffDays % 7 === 6; // 6 days difference = 7 days total (inclusive)
  }
  if (periodType === "MONTH") {
    // Must cover approximately one month period (28-35 days)
    // This allows starting from any date and provides flexibility for month length variations
    // addMonths() can result in 28-31 days difference depending on the starting month
    const minDays = 27; // Allow 28 days (Feb in non-leap year: Jan 31 to Feb 28 = 28 days)
    const maxDays = 35; // Allow some flexibility for user adjustments
    return diffDays >= minDays && diffDays <= maxDays;
  }
  // CUSTOM: Any valid date range
  return true;
}

export const upsertTimesheetSchema = z
  .object({
    periodType: timesheetPeriodSchema,
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    isActive: z.boolean().optional().default(true),
    shifts: z.array(staffShiftSchema).min(1),
    exceptions: z.array(scheduleExceptionSchema).optional().default([]),
  })
  .refine((t) => t.endDate >= t.startDate, {
    message: "End date must be after or equal to start date",
    path: ["endDate"],
  })
  .refine((t) => validatePeriodDates(t.periodType, t.startDate, t.endDate), {
    message:
      "Date range must align with period type: WEEK (7-day multiples), MONTH (approximately 28-35 days), or CUSTOM (any range)",
    path: ["endDate"],
  });

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type CreateDoctorInput = z.infer<typeof createDoctorSchema>;
export type EditDoctorInput = z.infer<typeof editDoctorSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type UserIdParam = z.infer<typeof userIdParamSchema>;
export type DoctorIdParam = z.infer<typeof doctorIdParamSchema>;
export type UpsertTimesheetInput = z.infer<typeof upsertTimesheetSchema>;
