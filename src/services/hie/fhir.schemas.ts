import { z } from "zod";

const identifierSchema = z.object({
  system: z.string().optional(),
  value: z.string().min(1),
});

const humanNameSchema = z.object({
  family: z.string().optional(),
  given: z.array(z.string()).optional(),
});

const telecomSchema = z.object({
  system: z.enum(["phone", "email"]).optional(),
  value: z.string().optional(),
  use: z.string().optional(),
});

const addressSchema = z.object({
  line: z.array(z.string()).optional(),
  city: z.string().optional(),
  district: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  postalCode: z.string().optional(),
});

export const fhirPatientSchema = z
  .object({
    resourceType: z.literal("Patient"),
    id: z.string().min(1),
    identifier: z.array(identifierSchema).default([]),
    active: z.boolean().optional(),
    name: z.array(humanNameSchema).default([]),
    gender: z.enum(["male", "female", "other", "unknown"]).optional(),
    birthDate: z.iso.date().optional(),
    deceasedBoolean: z.boolean().optional(),
    telecom: z.array(telecomSchema).default([]),
    address: z.array(addressSchema).default([]),
  })
  .passthrough();

const bundleEntrySchema = z.object({
  fullUrl: z.string().optional(),
  resource: z.record(z.string(), z.unknown()),
});

export const fhirBundleSchema = z
  .object({
    resourceType: z.literal("Bundle"),
    id: z.string().optional(),
    type: z.string().optional(),
    total: z.number().int().nonnegative().optional(),
    timestamp: z.string().optional(),
    entry: z.array(bundleEntrySchema).default([]),
  })
  .passthrough();

export type FhirPatient = z.infer<typeof fhirPatientSchema>;
export type FhirBundle = z.infer<typeof fhirBundleSchema>;

export const operationOutcomeSchema = z
  .object({
    resourceType: z.literal("OperationOutcome"),
    issue: z
      .array(
        z.object({
          severity: z.string().optional(),
          code: z.string().optional(),
          diagnostics: z.string().optional(),
        })
      )
      .optional(),
  })
  .passthrough();

export const capabilityStatementSchema = z
  .object({
    resourceType: z.literal("CapabilityStatement"),
    status: z.string().min(1),
    fhirVersion: z.string().min(1).optional(),
    rest: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();
