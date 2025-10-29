import { z } from "zod";

export const insuranceCompanySchema = z.object({
  companyName: z.string(),
  contactPhone: z.string().optional(),
  contactEmail: z.string().optional(),
});

export const employerSchema = z.object({
  employerName: z.string(),
  contactPhone: z.string().optional(),
  contactEmail: z.string().optional(),
});

export const patientInsuranceSchema = z.object({
  patientId: z.string(),
  insuranceCompanyId: z.string(),
  employerId: z.string().optional(),
  insuranceNumber: z.string(),
  coveragePercentage: z.number(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});
