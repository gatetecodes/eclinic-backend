import { z } from "zod";
import { nationalRecordSectionSchema } from "@/services/hie/national-record.service";

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

/**
 * UPID resolution at reception, for a patient the Client Registry has no FHIR
 * `Patient` for yet. `RESOLVE_UPI` is excluded: it is an administrative
 * reconciliation mode, not a reception lookup.
 */
export const requestPatientUpidSchema = z.object({
  documentType: z
    .enum([
      "NID",
      "NIDA",
      "NID_APPLICATION_NUMBER",
      "APPLICATION_NUMBER",
      "NIN",
      "PASSPORT",
      "TEMPID",
      "FOREIGNER_ID",
    ])
    .default("NID"),
  documentNumber: z.string().trim().min(1).max(64),
  patientId: z.number().int().positive().optional(),
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
  consentSyncEnabled: z.boolean().optional(),
  consultationWriteEnabled: z.boolean().optional(),
  nationalListReadEnabled: z.boolean().optional(),
  nationalAuditReadEnabled: z.boolean().optional(),
  emergencyReadEnabled: z.boolean().optional(),
  allergyWriteEnabled: z.boolean().optional(),
  immunizationWriteEnabled: z.boolean().optional(),
  imagingWriteEnabled: z.boolean().optional(),
});

const manualAttestationSchema = z.object({
  verificationStatus: z.enum([
    "PENDING",
    "MANUAL_ATTESTED",
    "CONFLICT",
    "REVOKED",
  ]),
  verificationSource: z.string().trim().min(2).max(100),
  verificationReference: z.string().trim().min(2).max(500),
  verificationExpiresAt: z.iso.datetime(),
});

export const upsertFacilityLinkSchema = manualAttestationSchema.extend({
  branchId: z.number().int().positive(),
  fosaCode: z.string().trim().min(1).max(100),
  locationReference: z
    .string()
    .trim()
    .regex(/^Location\/.+$/),
  displayName: z.string().trim().max(200).optional(),
});

export const upsertPractitionerLinkSchema = manualAttestationSchema.extend({
  userId: z.number().int().positive(),
  practitionerReference: z
    .string()
    .trim()
    .regex(
      /^Practitioner\/.+$/,
      "Practitioner reference must start with Practitioner/"
    ),
});

export const upsertDestinationFacilitySchema = manualAttestationSchema.extend({
  id: z.number().int().positive().optional(),
  fosaCode: z.string().trim().min(1).max(100),
  locationReference: z
    .string()
    .trim()
    .regex(/^Location\/.+$/, "Location reference must start with Location/"),
  displayName: z.string().trim().min(2).max(200),
});

/**
 * Registry-backed verification.
 *
 * These carry identifiers only — deliberately no `verificationStatus`,
 * `verificationSource`, `verificationReference` or `verificationExpiresAt`.
 * Those are provenance the server derives from the registry match, and keeping
 * them off the request surface is what makes "VERIFIED implies the server
 * matched this against the registry" an invariant rather than a convention.
 */
export const facilityDirectoryQuerySchema = z.object({
  search: z.string().trim().min(1).max(100).optional(),
  district: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const verifyFacilityLinkSchema = z.object({
  branchId: z.number().int().positive(),
});

export const verifyDestinationFacilitySchema = z.object({
  id: z.number().int().positive(),
});

export const verifyPractitionerLinkSchema = z.object({
  userId: z.number().int().positive(),
});

export type FacilityDirectoryQuery = z.infer<
  typeof facilityDirectoryQuerySchema
>;
export type VerifyFacilityInput = z.infer<typeof verifyFacilityLinkSchema>;
export type VerifyDestinationInput = z.infer<
  typeof verifyDestinationFacilitySchema
>;
export type VerifyPractitionerInput = z.infer<
  typeof verifyPractitionerLinkSchema
>;

export const coverageMappingSchema = manualAttestationSchema.extend({
  patientInsuranceId: z.number().int().positive(),
  coverageReference: z
    .string()
    .trim()
    .regex(/^Coverage\/[A-Za-z0-9.-]+$/),
});

export const dobDiscrepancyParamSchema = z.object({
  id: z.string().regex(/^[1-9]\d*$/),
});

export const correctDobDiscrepancySchema = z.object({
  action: z.enum(["CORRECT", "DISMISS"]),
  expectedPatientUpdatedAt: z.iso.datetime(),
  note: z.string().trim().min(10).max(1000),
});

export const patientParamSchema = z.object({
  patientId: z.string().regex(/^[1-9]\d*$/),
});

export const nationalRecordQuerySchema = z.object({
  sections: z
    .string()
    .trim()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(",")
            .map((section) => section.trim())
            .filter(Boolean)
        : nationalRecordSectionSchema.options
    )
    .pipe(z.array(nationalRecordSectionSchema).min(1).max(11)),
});

export const emergencyAccessSchema = z.object({
  reasonCode: z.enum([
    "LIFE_THREATENING",
    "PATIENT_UNCONSCIOUS",
    "URGENT_HISTORY_REQUIRED",
    "OTHER_EMERGENCY",
  ]),
  justification: z.string().trim().min(10).max(500),
  branchId: z.number().int().positive(),
});

export const emergencyAccessParamSchema = z.object({
  id: z.string().regex(/^[1-9]\d*$/),
});

export const emergencyAccessReviewSchema = z.object({
  status: z.enum(["APPROVED", "CONCERN"]),
  note: z.string().trim().min(3).max(1000),
});

export const consentSchema = z.object({
  patientId: z.number().int().positive(),
  scope: z.enum(["patient-privacy", "treatment", "research"]),
  purpose: z.string().trim().min(3).max(500),
  effectiveFrom: z.iso.datetime(),
  effectiveTo: z.iso.datetime().optional(),
  evidence: z.object({
    method: z.enum(["WRITTEN", "VERBAL", "ELECTRONIC"]),
    patientConfirmed: z.literal(true),
    witnessName: z.string().trim().min(2).max(200).optional(),
    documentReference: z.string().trim().min(3).max(500).optional(),
    note: z.string().trim().max(1000).optional(),
  }),
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

export const emergencyAccessQuerySchema = paginationSchema.extend({
  reviewStatus: z.enum(["PENDING", "APPROVED", "CONCERN"]).optional(),
  overdue: z.coerce.boolean().optional(),
});

export const coverageQuerySchema = paginationSchema.extend({
  patientId: z.coerce.number().int().positive().optional(),
  status: z
    .enum(["PENDING", "MANUAL_ATTESTED", "CONFLICT", "REVOKED"])
    .optional(),
});

export const nationalAuditQuerySchema = paginationSchema.extend({
  patientId: z.coerce.number().int().positive().optional(),
});

export const dobDiscrepancyQuerySchema = paginationSchema.extend({
  status: z.enum(["OPEN", "CORRECTED", "DISMISSED"]).optional(),
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

export const operationsSummaryQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(168).default(24),
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
  patientId: z.coerce.number().int().positive().optional(),
});

/**
 * Optional transfer context published as FHIR Encounter extensions. Kept
 * optional so an emergency transfer is never blocked on paperwork.
 */
const transferContextFields = {
  transferTypeCode: z.string().trim().min(1).max(64).optional(),
  transferTypeDisplay: z.string().trim().min(1).max(200).optional(),
  transportTypeCode: z.string().trim().min(1).max(64).optional(),
  transportTypeDisplay: z.string().trim().min(1).max(200).optional(),
  ambulanceCallTime: z.iso.datetime().optional(),
  departureTime: z.iso.datetime().optional(),
  receivingClinicianContact: z.string().trim().min(1).max(300).optional(),
  caregiverName: z.string().trim().min(1).max(200).optional(),
  caregiverPhone: z.string().trim().min(1).max(50).optional(),
};

export const createTransferSchema = z.object({
  visitId: z.number().int().positive(),
  destinationFacilityId: z.number().int().positive(),
  reason: z.string().trim().min(3).max(2000),
  urgency: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
  clinicalSummary: z.string().trim().min(10).max(20_000),
  ...transferContextFields,
});

export const transferParamSchema = z.object({
  transferId: z.string().regex(/^[1-9]\d*$/),
});

export const identityQueueQuerySchema = paginationSchema.extend({
  status: z.enum(["PENDING", "CONFLICT"]).optional(),
});

export const identityParamSchema = z.object({
  identityId: z.string().regex(/^[1-9]\d*$/),
});

export const identityCaseQuerySchema = paginationSchema.extend({
  status: z.enum(["OPEN", "RESOLVED", "DISMISSED"]).optional(),
});

export const identityCaseParamSchema = z.object({
  caseId: z.string().regex(/^[1-9]\d*$/),
});

export const resolveIdentityCaseSchema = z.object({
  status: z.enum(["RESOLVED", "DISMISSED"]),
  note: z.string().trim().min(3).max(2000),
});

export const auditQuerySchema = paginationSchema.extend({
  patientId: z.coerce.number().int().positive().optional(),
  capability: z.string().trim().min(1).max(100).optional(),
});

export const inboundTransferQuerySchema = paginationSchema.extend({
  patientId: z.coerce.number().int().positive().optional(),
  status: z
    .enum(["RECEIVED", "REVIEWED", "ACKNOWLEDGED", "COMPLETED", "DISMISSED"])
    .optional(),
});

export const inboundTransferParamSchema = z.object({
  inboundTransferId: z.string().regex(/^[1-9]\d*$/),
});

export const inboundTransferActionSchema = z.object({
  status: z.enum(["REVIEWED", "ACKNOWLEDGED", "COMPLETED", "DISMISSED"]),
  note: z.string().trim().max(2000).optional(),
});

export const cancelTransferSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
