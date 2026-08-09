import { Hono } from "hono";
import type { AppEnv } from "@/middlewares/auth.middleware";
import { requireFeature } from "@/middlewares/feature.middleware";
import { requirePermission } from "@/middlewares/rbac.middleware";
import { validate } from "@/middlewares/validation.middleware";
import {
  cancelExternalTransfer,
  createConsent,
  createExternalTransfer,
  deferVerification,
  getExternalTransfer,
  getPatientIps,
  getStatus,
  linkPatient,
  listExternalTransfers,
  listOutbox,
  lookupPatient,
  queueExternalTransfer,
  reconcileExternalResource,
  retryOutboxEvent,
  updateConfig,
  upsertFacilityLink,
  upsertPractitionerLink,
  withdrawConsent,
} from "./hie.controller";
import {
  cancelTransferSchema,
  consentParamSchema,
  consentSchema,
  createTransferSchema,
  deferVerificationSchema,
  linkPatientSchema,
  lookupPatientSchema,
  outboxEventParamSchema,
  outboxQuerySchema,
  patientParamSchema,
  reconciliationSchema,
  transferParamSchema,
  transferQuerySchema,
  updateConfigSchema,
  upsertFacilityLinkSchema,
  upsertPractitionerLinkSchema,
  withdrawConsentSchema,
} from "./hie.validation";

const router = new Hono<AppEnv>();
router.use("*", requireFeature("hie"));

router.get(
  "/status",
  requirePermission({ resource: "hie", action: "read" }),
  getStatus
);
router.put(
  "/config",
  requirePermission({ resource: "hie", action: "update" }),
  validate(updateConfigSchema),
  updateConfig
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
router.post(
  "/patients/lookup",
  requirePermission({ resource: "hie", action: "approve" }),
  validate(lookupPatientSchema),
  lookupPatient
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
  "/patients/:patientId/ips",
  requirePermission({ resource: "hie", action: "read" }),
  validate(patientParamSchema, "param"),
  getPatientIps
);
router.post(
  "/consents",
  requirePermission({ resource: "hie", action: "create" }),
  validate(consentSchema),
  createConsent
);
router.post(
  "/consents/:consentId/withdraw",
  requirePermission({ resource: "hie", action: "update" }),
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
router.post(
  "/outbox/:eventId/retry",
  requirePermission({ resource: "hie", action: "process" }),
  validate(outboxEventParamSchema, "param"),
  retryOutboxEvent
);
router.get(
  "/transfers",
  requirePermission({ resource: "hie", action: "read" }),
  validate(transferQuerySchema, "query"),
  listExternalTransfers
);
router.get(
  "/transfers/:transferId",
  requirePermission({ resource: "hie", action: "read" }),
  validate(transferParamSchema, "param"),
  getExternalTransfer
);
router.post(
  "/transfers",
  requirePermission({ resource: "hie", action: "create" }),
  validate(createTransferSchema),
  createExternalTransfer
);
router.post(
  "/transfers/:transferId/queue",
  requirePermission({ resource: "hie", action: "create" }),
  validate(transferParamSchema, "param"),
  queueExternalTransfer
);
router.post(
  "/transfers/:transferId/cancel",
  requirePermission({ resource: "hie", action: "update" }),
  validate(transferParamSchema, "param"),
  validate(cancelTransferSchema),
  cancelExternalTransfer
);

export default router;
