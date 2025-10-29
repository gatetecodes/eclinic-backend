import { z } from "zod";

export const demoRequestSchema = z.object({
  clinic_name: z.string().min(1, "Clinic name is required"),
  email: z.email(),
  phone_number: z
    .string()
    .min(8, "Phone too short")
    .max(20, "Phone too long")
    .regex(/^[+()\d\s-]+$/, "Invalid phone number"),
  address: z.string().min(1, "Address is required"),
  demo_date: z.coerce.date(),
});
