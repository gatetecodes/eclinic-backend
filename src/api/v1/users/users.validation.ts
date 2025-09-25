import { z } from "zod";

const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

const staffRoles = [
  "RECEPTIONIST",
  "PHARMACIST",
  "LAB_TECHNICIAN",
  "CASHIER",
  "NURSE",
  "STOCK_MANAGER",
] as const;

export const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(staffRoles),
  phone_number: z.string().min(10),
});

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

export const createDoctorSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().email(),
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

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type CreateDoctorInput = z.infer<typeof createDoctorSchema>;
export type EditDoctorInput = z.infer<typeof editDoctorSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type UserIdParam = z.infer<typeof userIdParamSchema>;
export type DoctorIdParam = z.infer<typeof doctorIdParamSchema>;
