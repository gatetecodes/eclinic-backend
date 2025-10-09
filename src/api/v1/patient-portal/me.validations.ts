import { z } from "zod";

export const meInitSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  dateOfBirth: z.string(),
  gender: z.enum(["MALE", "FEMALE"]),
  phoneNumber: z.string().min(8),
  email: z.string().email().optional(),
});

export const meLinkSchema = z.object({
  patientId: z.number(),
  phoneNumber: z.string().min(8),
});
