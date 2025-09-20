import { z } from "zod";

export const demoRequestSchema = z.object({
  clinic_name: z.string(),
  email: z.email(),
  phone_number: z.string(),
  address: z.string(),
  demo_date: z.any(),
});
