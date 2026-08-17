import { Hono } from "hono";
import type { AppEnv } from "@/middlewares/auth.middleware";
import { requireFeature } from "@/middlewares/feature.middleware";
import { requirePermission } from "@/middlewares/rbac.middleware";
import { validate } from "@/middlewares/validation.middleware";
import {
  correctStructuredAllergy,
  correctStructuredImmunization,
  createConsultationObservation,
  createImagingOrder,
  createImagingStudy,
  createStructuredAllergy,
  createStructuredImmunization,
  deleteStructuredAllergy,
  deleteStructuredImmunization,
  finalizeConsultationObservation,
  finalizeImagingOrder,
  finalizeImagingStudy,
  finalizeStructuredAllergy,
  finalizeStructuredImmunization,
  listConsultationObservations,
  listImagingMetadata,
  listStructuredAllergies,
  listStructuredImmunizations,
  listVerifiedClinicalConcepts,
  updateStructuredAllergy,
  updateStructuredImmunization,
} from "./clinical.controller";
import {
  clinicalConceptQuerySchema,
  consultationObservationSchema,
  imagingOrderSchema,
  imagingStudySchema,
  structuredAllergyCorrectionSchema,
  structuredAllergySchema,
  structuredImmunizationCorrectionSchema,
  structuredImmunizationSchema,
  structuredRecordListSchema,
  structuredRecordParamSchema,
} from "./clinical.validation";
import {
  listCoverageMappings,
  listDobDiscrepancies,
  listNationalAudit,
  refreshDobDiscrepancies,
  resolveDobDiscrepancy,
  upsertCoverageMapping,
} from "./governance.controller";
import {
  cancelExternalTransfer,
  createConsent,
  createEmergencyAccess,
  createExternalTransfer,
  deferVerification,
  getExternalTransfer,
  getLiveStatus,
  getMappings,
  getOperationsSummary,
  getPatientConsent,
  getPatientIdentityStatus,
  getPatientIps,
  getPatientNationalRecord,
  getStatus,
  linkPatient,
  listEmergencyAccess,
  listExternalTransfers,
  listHieAudit,
  listIdentityCases,
  listInboundTransfers,
  listOutbox,
  listPendingIdentities,
  lookupPatient,
  queueExternalTransfer,
  reconcileExternalResource,
  reconcilePatientConsent,
  refreshInboundTransfers,
  requestPatientUpid,
  resolveIdentityCase,
  retryOutboxEvent,
  retryPendingIdentity,
  reviewEmergencyAccess,
  updateConfig,
  updateInboundTransfer,
  upsertDestinationFacility,
  upsertFacilityLink,
  upsertPractitionerLink,
  withdrawConsent,
} from "./hie.controller";
import {
  auditQuerySchema,
  cancelTransferSchema,
  consentParamSchema,
  consentSchema,
  correctDobDiscrepancySchema,
  coverageMappingSchema,
  coverageQuerySchema,
  createTransferSchema,
  deferVerificationSchema,
  dobDiscrepancyParamSchema,
  dobDiscrepancyQuerySchema,
  emergencyAccessParamSchema,
  emergencyAccessQuerySchema,
  emergencyAccessReviewSchema,
  emergencyAccessSchema,
  facilityDirectoryQuerySchema,
  identityCaseParamSchema,
  identityCaseQuerySchema,
  identityParamSchema,
  identityQueueQuerySchema,
  inboundTransferActionSchema,
  inboundTransferParamSchema,
  inboundTransferQuerySchema,
  linkPatientSchema,
  lookupPatientSchema,
  nationalAuditQuerySchema,
  nationalRecordQuerySchema,
  operationsSummaryQuerySchema,
  outboxEventParamSchema,
  outboxQuerySchema,
  patientParamSchema,
  reconciliationSchema,
  requestPatientUpidSchema,
  resolveIdentityCaseSchema,
  transferParamSchema,
  transferQuerySchema,
  updateConfigSchema,
  upsertDestinationFacilitySchema,
  upsertFacilityLinkSchema,
  upsertPractitionerLinkSchema,
  verifyDestinationFacilitySchema,
  verifyFacilityLinkSchema,
  verifyPractitionerLinkSchema,
  withdrawConsentSchema,
} from "./hie.validation";
import {
  searchRegistryFacilities,
  syncRegistryFacilities,
  verifyDestinationFacility,
  verifyFacilityLink,
  verifyPractitionerLink,
} from "./registry.controller";

const router = new Hono<AppEnv>();
router.use("*", requireFeature("hie"));

router.get(
  "/status",
  requirePermission({ resource: "hie", action: "read" }),
  getStatus
);
// Same payload as /status, but re-probes the national services first. Declared
// alongside /status so no later parameterised route can shadow it.
router.get(
  "/status/live",
  requirePermission({ resource: "hie", action: "read" }),
  getLiveStatus
);
router.get(
  "/concepts",
  requirePermission({ resource: "hie", action: "read" }),
  validate(clinicalConceptQuerySchema, "query"),
  listVerifiedClinicalConcepts
);
router.put(
  "/config",
  requirePermission({ resource: "hie", action: "update" }),
  validate(updateConfigSchema),
  updateConfig
);
router.get(
  "/coverage-mappings",
  requirePermission({ resource: "hie", action: "process" }),
  validate(coverageQuerySchema, "query"),
  listCoverageMappings
);
router.put(
  "/coverage-mappings",
  requirePermission({ resource: "hie", action: "update" }),
  validate(coverageMappingSchema),
  upsertCoverageMapping
);
router.get(
  "/national-audit",
  requirePermission({ resource: "hie", action: "process" }),
  validate(nationalAuditQuerySchema, "query"),
  listNationalAudit
);
router.get(
  "/dob-discrepancies",
  requirePermission({ resource: "hie", action: "process" }),
  validate(dobDiscrepancyQuerySchema, "query"),
  listDobDiscrepancies
);
router.post(
  "/dob-discrepancies/refresh",
  requirePermission({ resource: "hie", action: "process" }),
  refreshDobDiscrepancies
);
router.post(
  "/dob-discrepancies/:id/resolve",
  requirePermission({ resource: "hie", action: "process" }),
  validate(dobDiscrepancyParamSchema, "param"),
  validate(correctDobDiscrepancySchema),
  resolveDobDiscrepancy
);
router.get(
  "/mappings",
  requirePermission({ resource: "hie", action: "read" }),
  getMappings
);
router.put(
  "/facilities",
  requirePermission({ resource: "hie", action: "update" }),
  validate(upsertFacilityLinkSchema),
  upsertFacilityLink
);
router.put(
  "/practitioners",
  requirePermission({ resource: "hie", action: "update" }),
  validate(upsertPractitionerLinkSchema),
  upsertPractitionerLink
);
router.put(
  "/destinations",
  requirePermission({ resource: "hie", action: "update" }),
  validate(upsertDestinationFacilitySchema),
  upsertDestinationFacility
);

/**
 * Registry-backed mapping. `read` for the directory search that feeds the
 * facility picker, `update` for a verification (it mutates a mapping's status,
 * exactly like the PUTs above), and `process` — CLINIC_ADMIN only — to force a
 * sweep of the national list.
 */
router.get(
  "/registry/facilities",
  requirePermission({ resource: "hie", action: "read" }),
  validate(facilityDirectoryQuerySchema, "query"),
  searchRegistryFacilities
);
router.post(
  "/registry/facilities/sync",
  requirePermission({ resource: "hie", action: "process" }),
  syncRegistryFacilities
);
router.post(
  "/facilities/verify",
  requirePermission({ resource: "hie", action: "update" }),
  validate(verifyFacilityLinkSchema),
  verifyFacilityLink
);
router.post(
  "/destinations/verify",
  requirePermission({ resource: "hie", action: "update" }),
  validate(verifyDestinationFacilitySchema),
  verifyDestinationFacility
);
router.post(
  "/practitioners/verify",
  requirePermission({ resource: "hie", action: "update" }),
  validate(verifyPractitionerLinkSchema),
  verifyPractitionerLink
);
router.post(
  "/patients/lookup",
  requirePermission({ resource: "hie", action: "approve" }),
  validate(lookupPatientSchema),
  lookupPatient
);
router.post(
  "/patients/request-upid",
  requirePermission({ resource: "hie", action: "approve" }),
  validate(requestPatientUpidSchema),
  requestPatientUpid
);
router.post(
  "/patients/link",
  requirePermission({ resource: "hie", action: "approve" }),
  validate(linkPatientSchema),
  linkPatient
);
router.post(
  "/patients/defer-verification",
  requirePermission({ resource: "hie", action: "approve" }),
  validate(deferVerificationSchema),
  deferVerification
);
router.get(
  "/patients/:patientId/identity",
  requirePermission({ resource: "hie", action: "read" }),
  validate(patientParamSchema, "param"),
  getPatientIdentityStatus
);
router.get(
  "/identities/pending",
  requirePermission({ resource: "hie", action: "process" }),
  validate(identityQueueQuerySchema, "query"),
  listPendingIdentities
);
router.post(
  "/identities/:identityId/retry",
  requirePermission({ resource: "hie", action: "process" }),
  validate(identityParamSchema, "param"),
  retryPendingIdentity
);
router.get(
  "/identity-cases",
  requirePermission({ resource: "hie", action: "process" }),
  validate(identityCaseQuerySchema, "query"),
  listIdentityCases
);
router.put(
  "/identity-cases/:caseId",
  requirePermission({ resource: "hie", action: "process" }),
  validate(identityCaseParamSchema, "param"),
  validate(resolveIdentityCaseSchema),
  resolveIdentityCase
);
router.get(
  "/audit",
  requirePermission({ resource: "hie", action: "process" }),
  validate(auditQuerySchema, "query"),
  listHieAudit
);
router.get(
  "/patients/:patientId/ips",
  requirePermission({ resource: "hie", action: "read" }),
  validate(patientParamSchema, "param"),
  getPatientIps
);
router.get(
  "/patients/:patientId/national-record",
  requirePermission({ resource: "hie", action: "read" }),
  validate(patientParamSchema, "param"),
  validate(nationalRecordQuerySchema, "query"),
  getPatientNationalRecord
);
router.post(
  "/patients/:patientId/emergency-access",
  requirePermission({ resource: "hie", action: "emergencyHieRead" }),
  validate(patientParamSchema, "param"),
  validate(emergencyAccessSchema),
  createEmergencyAccess
);
router.get(
  "/emergency-access",
  requirePermission({
    resource: "hie",
    action: "reviewEmergencyHieAccess",
  }),
  validate(emergencyAccessQuerySchema, "query"),
  listEmergencyAccess
);
router.post(
  "/emergency-access/:id/review",
  requirePermission({
    resource: "hie",
    action: "reviewEmergencyHieAccess",
  }),
  validate(emergencyAccessParamSchema, "param"),
  validate(emergencyAccessReviewSchema),
  reviewEmergencyAccess
);
router.get(
  "/patients/:patientId/consultation-observations",
  requirePermission({ resource: "hie", action: "read" }),
  validate(patientParamSchema, "param"),
  validate(structuredRecordListSchema, "query"),
  listConsultationObservations
);
router.post(
  "/patients/:patientId/consultation-observations",
  requirePermission({ resource: "hie", action: "update" }),
  validate(patientParamSchema, "param"),
  validate(consultationObservationSchema),
  createConsultationObservation
);
router.post(
  "/consultation-observations/:id/finalize",
  requirePermission({ resource: "hie", action: "update" }),
  validate(structuredRecordParamSchema, "param"),
  finalizeConsultationObservation
);
router.get(
  "/patients/:patientId/allergies",
  requirePermission({ resource: "hie", action: "read" }),
  validate(patientParamSchema, "param"),
  validate(structuredRecordListSchema, "query"),
  listStructuredAllergies
);
router.post(
  "/patients/:patientId/allergies",
  requirePermission({ resource: "hie", action: "manageHieAllergies" }),
  validate(patientParamSchema, "param"),
  validate(structuredAllergySchema),
  createStructuredAllergy
);
router.post(
  "/allergies/:id/finalize",
  requirePermission({ resource: "hie", action: "manageHieAllergies" }),
  validate(structuredRecordParamSchema, "param"),
  finalizeStructuredAllergy
);
router.put(
  "/allergies/:id",
  requirePermission({ resource: "hie", action: "manageHieAllergies" }),
  validate(structuredRecordParamSchema, "param"),
  validate(structuredAllergySchema),
  updateStructuredAllergy
);
router.delete(
  "/allergies/:id",
  requirePermission({ resource: "hie", action: "manageHieAllergies" }),
  validate(structuredRecordParamSchema, "param"),
  deleteStructuredAllergy
);
router.post(
  "/allergies/:id/correct",
  requirePermission({ resource: "hie", action: "manageHieAllergies" }),
  validate(structuredRecordParamSchema, "param"),
  validate(structuredAllergyCorrectionSchema),
  correctStructuredAllergy
);
router.get(
  "/patients/:patientId/immunizations",
  requirePermission({ resource: "hie", action: "read" }),
  validate(patientParamSchema, "param"),
  validate(structuredRecordListSchema, "query"),
  listStructuredImmunizations
);
router.post(
  "/patients/:patientId/immunizations",
  requirePermission({ resource: "hie", action: "manageHieImmunizations" }),
  validate(patientParamSchema, "param"),
  validate(structuredImmunizationSchema),
  createStructuredImmunization
);
router.post(
  "/immunizations/:id/finalize",
  requirePermission({ resource: "hie", action: "manageHieImmunizations" }),
  validate(structuredRecordParamSchema, "param"),
  finalizeStructuredImmunization
);
router.put(
  "/immunizations/:id",
  requirePermission({ resource: "hie", action: "manageHieImmunizations" }),
  validate(structuredRecordParamSchema, "param"),
  validate(structuredImmunizationSchema),
  updateStructuredImmunization
);
router.delete(
  "/immunizations/:id",
  requirePermission({ resource: "hie", action: "manageHieImmunizations" }),
  validate(structuredRecordParamSchema, "param"),
  deleteStructuredImmunization
);
router.post(
  "/immunizations/:id/correct",
  requirePermission({ resource: "hie", action: "manageHieImmunizations" }),
  validate(structuredRecordParamSchema, "param"),
  validate(structuredImmunizationCorrectionSchema),
  correctStructuredImmunization
);
router.get(
  "/patients/:patientId/imaging",
  requirePermission({ resource: "hie", action: "read" }),
  validate(patientParamSchema, "param"),
  validate(structuredRecordListSchema, "query"),
  listImagingMetadata
);
router.post(
  "/patients/:patientId/imaging/orders",
  requirePermission({ resource: "hie", action: "manageHieImaging" }),
  validate(patientParamSchema, "param"),
  validate(imagingOrderSchema),
  createImagingOrder
);
router.post(
  "/imaging/orders/:id/finalize",
  requirePermission({ resource: "hie", action: "manageHieImaging" }),
  validate(structuredRecordParamSchema, "param"),
  finalizeImagingOrder
);
router.post(
  "/patients/:patientId/imaging/studies",
  requirePermission({ resource: "hie", action: "manageHieImaging" }),
  validate(patientParamSchema, "param"),
  validate(imagingStudySchema),
  createImagingStudy
);
router.post(
  "/imaging/studies/:id/finalize",
  requirePermission({ resource: "hie", action: "manageHieImaging" }),
  validate(structuredRecordParamSchema, "param"),
  finalizeImagingStudy
);
router.get(
  "/patients/:patientId/consent",
  requirePermission({ resource: "hie", action: "read" }),
  validate(patientParamSchema, "param"),
  getPatientConsent
);
router.post(
  "/patients/:patientId/consent/reconcile",
  requirePermission({ resource: "hie", action: "manageHieConsent" }),
  validate(patientParamSchema, "param"),
  reconcilePatientConsent
);
router.post(
  "/consents",
  requirePermission({ resource: "hie", action: "manageHieConsent" }),
  validate(consentSchema),
  createConsent
);
router.post(
  "/consents/:consentId/withdraw",
  requirePermission({ resource: "hie", action: "manageHieConsent" }),
  validate(consentParamSchema, "param"),
  validate(withdrawConsentSchema),
  withdrawConsent
);
router.post(
  "/reconciliations",
  requirePermission({ resource: "hie", action: "create" }),
  validate(reconciliationSchema),
  reconcileExternalResource
);
router.get(
  "/outbox",
  requirePermission({ resource: "hie", action: "process" }),
  validate(outboxQuerySchema, "query"),
  listOutbox
);
router.get(
  "/operations/summary",
  requirePermission({ resource: "hie", action: "process" }),
  validate(operationsSummaryQuerySchema, "query"),
  getOperationsSummary
);
router.post(
  "/outbox/:eventId/retry",
  requirePermission({ resource: "hie", action: "process" }),
  validate(outboxEventParamSchema, "param"),
  retryOutboxEvent
);
router.get(
  "/transfers",
  requirePermission({ resource: "hie", action: "viewHieTransfers" }),
  validate(transferQuerySchema, "query"),
  listExternalTransfers
);
router.post(
  "/patients/:patientId/inbound-transfers/refresh",
  requirePermission({ resource: "hie", action: "manageHieTransfers" }),
  validate(patientParamSchema, "param"),
  refreshInboundTransfers
);
router.get(
  "/inbound-transfers",
  requirePermission({ resource: "hie", action: "viewHieTransfers" }),
  validate(inboundTransferQuerySchema, "query"),
  listInboundTransfers
);
router.put(
  "/inbound-transfers/:inboundTransferId",
  requirePermission({ resource: "hie", action: "manageHieTransfers" }),
  validate(inboundTransferParamSchema, "param"),
  validate(inboundTransferActionSchema),
  updateInboundTransfer
);
router.get(
  "/transfers/:transferId",
  requirePermission({ resource: "hie", action: "viewHieTransfers" }),
  validate(transferParamSchema, "param"),
  getExternalTransfer
);
router.post(
  "/transfers",
  requirePermission({ resource: "hie", action: "manageHieTransfers" }),
  validate(createTransferSchema),
  createExternalTransfer
);
router.post(
  "/transfers/:transferId/queue",
  requirePermission({ resource: "hie", action: "manageHieTransfers" }),
  validate(transferParamSchema, "param"),
  queueExternalTransfer
);
router.post(
  "/transfers/:transferId/cancel",
  requirePermission({ resource: "hie", action: "manageHieTransfers" }),
  validate(transferParamSchema, "param"),
  validate(cancelTransferSchema),
  cancelExternalTransfer
);

export default router;
