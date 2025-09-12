import { z } from "zod";

export const updateUserSchema = z.object({
  name: z.string().optional(),
  email: z.string().email().optional(),
  phone_number: z.string().optional(),
  role: z.string().optional(),
  status: z.string().optional(),
  consultationFee: z.number().optional(),
  licenseExpiration: z.string().optional(),
  licenseNumber: z.string().optional(),
  license_document: z.string().optional(),
  diploma_document: z.string().optional(),
  highestEducation: z.string().optional(),
  clinicId: z.number().optional(),
  branchId: z.number().optional(),
});

export type UpdateUserInput = Partial<z.infer<typeof updateUserSchema>>;
