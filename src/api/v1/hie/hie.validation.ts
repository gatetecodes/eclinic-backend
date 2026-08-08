import { z } from "zod";

const nidSchema = z
  .string()
  .trim()
  .regex(/^\d{16}$/, "NID must contain 16 digits");
const birthDateSchema = z.iso
  .date()
  .refine(
    (value) => new Date(`${value}T00:00:00.000Z`) <= new Date(),
    "Birth date cannot be in the future"
  );

export const lookupPatientSchema = z.object({
  nid: nidSchema,
  birthDate: birthDateSchema,
});

export const linkPatientSchema = z.object({
  patientId: z.number().int().positive(),
  nid: nidSchema,
  birthDate: birthDateSchema,
  externalPatientId: z.string().trim().min(1).max(200),
  expectedPatientUpdatedAt: z.iso.datetime(),
  reviewedFields: z
    .array(
      z.enum([
        "firstName",
        "lastName",
        "dateOfBirth",
        "gender",
        "phoneNumber",
        "email",
        "address",
      ])
    )
    .default([]),
});

export const deferVerificationSchema = z.object({
  patientId: z.number().int().positive(),
  nid: nidSchema,
  birthDate: birthDateSchema,
  reason: z.enum([
    "REGISTRY_UNAVAILABLE",
    "LINK_REQUIRES_RECONCILIATION",
    "MISSING_CONCURRENCY_TOKEN",
  ]),
  note: z.string().trim().min(3).max(500).optional(),
});

export const updateConfigSchema = z.object({
  environment: z.enum(["TEST", "PRODUCTION"]).optional(),
  enabled: z.boolean().optional(),
  clientRegistryEnabled: z.boolean().optional(),
  sharedRecordReadEnabled: z.boolean().optional(),
  sharedRecordWriteEnabled: z.boolean().optional(),
  transferEnabled: z.boolean().optional(),
});

export const upsertFacilityLinkSchema = z.object({
  branchId: z.number().int().positive(),
  fosaCode: z.string().trim().min(1).max(100),
  locationReference: z
    .string()
    .trim()
    .regex(/^Location\/.+$/, "Location reference must start with Location/"),
  displayName: z.string().trim().max(200).optional(),
  verificationStatus: z
    .enum(["PENDING", "VERIFIED", "CONFLICT", "REVOKED"])
    .default("PENDING"),
});

export const upsertPractitionerLinkSchema = z.object({
  userId: z.number().int().positive(),
  practitionerReference: z
    .string()
    .trim()
    .regex(
      /^Practitioner\/.+$/,
      "Practitioner reference must start with Practitioner/"
    ),
  verificationStatus: z
    .enum(["PENDING", "VERIFIED", "CONFLICT", "REVOKED"])
    .default("PENDING"),
});

export const patientParamSchema = z.object({
  patientId: z.string().regex(/^[1-9]\d*$/),
});

export const consentSchema = z.object({
  patientId: z.number().int().positive(),
  scope: z.enum(["patient-privacy", "treatment", "research"]),
  purpose: z.string().trim().min(3).max(500),
  effectiveFrom: z.iso.datetime(),
  effectiveTo: z.iso.datetime().optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
});

export const withdrawConsentSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const consentParamSchema = z.object({
  consentId: z.string().regex(/^[1-9]\d*$/),
});

export const reconciliationSchema = z.object({
  patientId: z.number().int().positive(),
  reconciliationToken: z.string().trim().min(20).max(5000),
  status: z.enum(["ACCEPTED", "DISMISSED"]),
  notes: z.string().trim().max(2000).optional(),
});

export const outboxEventParamSchema = z.object({
  eventId: z.string().uuid(),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
});

export const outboxQuerySchema = paginationSchema.extend({
  status: z
    .enum([
      "PENDING",
      "PROCESSING",
      "RETRY",
      "BLOCKED",
      "SUCCEEDED",
      "DEAD_LETTER",
    ])
    .optional(),
});

export const transferQuerySchema = paginationSchema.extend({
  status: z
    .enum([
      "DRAFT",
      "QUEUED",
      "SENT",
      "ACKNOWLEDGED",
      "FAILED",
      "CANCELLED",
      "COMPLETED",
    ])
    .optional(),
});

export const createTransferSchema = z.object({
  visitId: z.number().int().positive(),
  destinationFosaCode: z.string().trim().min(1).max(100),
  destinationLocationReference: z
    .string()
    .trim()
    .regex(/^Location\/.+$/, "Destination must start with Location/"),
  reason: z.string().trim().min(3).max(2000),
  urgency: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
  clinicalSummary: z.string().trim().min(10).max(20_000),
});

export const transferParamSchema = z.object({
  transferId: z.string().regex(/^[1-9]\d*$/),
});

export const cancelTransferSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
