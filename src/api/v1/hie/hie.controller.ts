import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { z } from "zod";
import { db } from "@/database/db";
import { jsonSuccess } from "@/lib/api-response";
import { AppError, isUniqueViolationOn, notFoundError } from "@/lib/app-error";
import type { AppEnv } from "@/middlewares/auth.middleware";
import { lookupNationalPatient } from "@/services/hie/client-registry.service";
import {
  capabilityStatementSchema,
  fhirBundleSchema,
  fhirConsentSchema,
} from "@/services/hie/fhir.schemas";
import {
  assertHieEncryptionConfigured,
  decryptHieJson,
  decryptHieValue,
  encryptHieJson,
  encryptHieValue,
  hashHieIdentifier,
} from "@/services/hie/hie-crypto.service";
import { hieOutboxIdempotencyKey } from "@/services/hie/hie-resource-id";
import {
  birthDateStorageWindow,
  prioritizeLinkedCandidates,
} from "@/services/hie/local-patient-matching";
import {
  nationalRecordSectionSchema,
  retrieveNationalRecord,
} from "@/services/hie/national-record.service";
import { getHieOperationsSummary } from "@/services/hie/operations-metrics.service";
import {
  resumeBlockedPatientEvents,
  retryHieEvent,
} from "@/services/hie/outbox.service";
import { RhieRequestError, rhieRequest } from "@/services/hie/rhie-client";
import { getInternationalPatientSummaryView } from "@/services/hie/shared-record.service";
import type { Prisma } from "../../../../generated/prisma/client";
import type {
  auditQuerySchema,
  cancelTransferSchema,
  consentSchema,
  createTransferSchema,
  deferVerificationSchema,
  emergencyAccessQuerySchema,
  emergencyAccessReviewSchema,
  emergencyAccessSchema,
  identityCaseQuerySchema,
  identityQueueQuerySchema,
  inboundTransferActionSchema,
  inboundTransferQuerySchema,
  linkPatientSchema,
  lookupPatientSchema,
  nationalRecordQuerySchema,
  operationsSummaryQuerySchema,
  outboxQuerySchema,
  reconciliationSchema,
  transferQuerySchema,
  updateConfigSchema,
  upsertDestinationFacilitySchema,
  upsertFacilityLinkSchema,
  upsertPractitionerLinkSchema,
  withdrawConsentSchema,
} from "./hie.validation";

type LookupInput = z.infer<typeof lookupPatientSchema>;
type LinkInput = z.infer<typeof linkPatientSchema>;
type DeferInput = z.infer<typeof deferVerificationSchema>;
type ConfigInput = z.infer<typeof updateConfigSchema>;
type FacilityInput = z.infer<typeof upsertFacilityLinkSchema>;
type PractitionerInput = z.infer<typeof upsertPractitionerLinkSchema>;
type DestinationFacilityInput = z.infer<typeof upsertDestinationFacilitySchema>;
type ConsentInput = z.infer<typeof consentSchema>;
type WithdrawConsentInput = z.infer<typeof withdrawConsentSchema>;
type ReconciliationInput = z.infer<typeof reconciliationSchema>;
type CreateTransferInput = z.infer<typeof createTransferSchema>;
type CancelTransferInput = z.infer<typeof cancelTransferSchema>;
type OutboxQuery = z.infer<typeof outboxQuerySchema>;
type OperationsSummaryQuery = z.infer<typeof operationsSummaryQuerySchema>;
type TransferQuery = z.infer<typeof transferQuerySchema>;
type IdentityQueueQuery = z.infer<typeof identityQueueQuerySchema>;
type IdentityCaseQuery = z.infer<typeof identityCaseQuerySchema>;
type AuditQuery = z.infer<typeof auditQuerySchema>;
type InboundTransferQuery = z.infer<typeof inboundTransferQuerySchema>;
type NationalRecordQuery = z.infer<typeof nationalRecordQuerySchema>;
type EmergencyAccessInput = z.infer<typeof emergencyAccessSchema>;
type EmergencyAccessReviewInput = z.infer<typeof emergencyAccessReviewSchema>;
type EmergencyAccessQuery = z.infer<typeof emergencyAccessQuerySchema>;
type InboundTransferAction = z.infer<typeof inboundTransferActionSchema>;

const reconciliationTokenSchema = z.object({
  patientId: z.number().int().positive(),
  resourceType: z.string().trim().min(1).max(100),
  resourceId: z.string().trim().min(1).max(200),
  expiresAt: z.iso.datetime(),
});

const pendingIdentitySnapshotSchema = z.object({
  birthDate: z.iso.date(),
});

const fhirEncounterSummarySchema = z
  .object({
    resourceType: z.literal("Encounter"),
    id: z.string().trim().min(1).max(200),
    period: z.object({ start: z.iso.datetime().optional() }).optional(),
    type: z
      .array(
        z.object({
          text: z.string().optional(),
          coding: z.array(z.object({ code: z.string().optional() })).optional(),
        })
      )
      .optional(),
    participant: z
      .array(
        z.object({
          individual: z.object({ display: z.string().optional() }).optional(),
        })
      )
      .optional(),
    hospitalization: z
      .object({
        origin: z
          .object({
            reference: z.string().optional(),
            display: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .passthrough();

function decodeReconciliationToken(value: string) {
  try {
    return reconciliationTokenSchema.parse(decryptHieJson(value));
  } catch {
    throw new AppError({
      status: 400,
      code: "HIE_RECONCILIATION_TOKEN_INVALID",
      message: "The reconciliation token is invalid or expired",
      exposeMessage: true,
    });
  }
}

type EffectiveHieConfig = Required<ConfigInput>;

function effectiveHieConfig(
  input: ConfigInput,
  existing: EffectiveHieConfig | null
): EffectiveHieConfig {
  return {
    environment: input.environment ?? existing?.environment ?? "TEST",
    enabled: input.enabled ?? existing?.enabled ?? false,
    clientRegistryEnabled:
      input.clientRegistryEnabled ?? existing?.clientRegistryEnabled ?? false,
    sharedRecordReadEnabled:
      input.sharedRecordReadEnabled ??
      existing?.sharedRecordReadEnabled ??
      false,
    sharedRecordWriteEnabled:
      input.sharedRecordWriteEnabled ??
      existing?.sharedRecordWriteEnabled ??
      false,
    transferEnabled:
      input.transferEnabled ?? existing?.transferEnabled ?? false,
    consentSyncEnabled:
      input.consentSyncEnabled ?? existing?.consentSyncEnabled ?? false,
    consultationWriteEnabled:
      input.consultationWriteEnabled ??
      existing?.consultationWriteEnabled ??
      false,
    nationalListReadEnabled:
      input.nationalListReadEnabled ??
      existing?.nationalListReadEnabled ??
      false,
    nationalAuditReadEnabled:
      input.nationalAuditReadEnabled ??
      existing?.nationalAuditReadEnabled ??
      false,
    emergencyReadEnabled:
      input.emergencyReadEnabled ?? existing?.emergencyReadEnabled ?? false,
    allergyWriteEnabled:
      input.allergyWriteEnabled ?? existing?.allergyWriteEnabled ?? false,
    immunizationWriteEnabled:
      input.immunizationWriteEnabled ??
      existing?.immunizationWriteEnabled ??
      false,
    imagingWriteEnabled:
      input.imagingWriteEnabled ?? existing?.imagingWriteEnabled ?? false,
  };
}

function sharedRecordCapabilityEnabled(config: EffectiveHieConfig): boolean {
  return (
    config.sharedRecordReadEnabled ||
    config.sharedRecordWriteEnabled ||
    config.transferEnabled ||
    config.consentSyncEnabled ||
    config.consultationWriteEnabled ||
    config.nationalListReadEnabled ||
    config.nationalAuditReadEnabled ||
    config.emergencyReadEnabled ||
    config.allergyWriteEnabled ||
    config.immunizationWriteEnabled ||
    config.imagingWriteEnabled
  );
}

function enabledPublicationResourceFilters(config: EffectiveHieConfig) {
  const filters: Array<{ resourceType: string | { in: string[] } }> = [];
  if (config.sharedRecordWriteEnabled) {
    filters.push({
      resourceType: { in: ["Encounter", "Condition", "Observation"] },
    });
  }
  if (config.transferEnabled) {
    filters.push({
      resourceType: { in: ["TransferEncounter", "TransferIPS"] },
    });
  }
  if (config.consentSyncEnabled) {
    filters.push({ resourceType: "Consent" });
  }
  if (config.consultationWriteEnabled) {
    filters.push({
      resourceType: {
        in: ["ConsultationEncounter", "ConsultationObservation"],
      },
    });
  }
  if (config.allergyWriteEnabled) {
    filters.push({ resourceType: "AllergyIntolerance" });
  }
  if (config.immunizationWriteEnabled) {
    filters.push({ resourceType: "Immunization" });
  }
  if (config.imagingWriteEnabled) {
    filters.push({
      resourceType: { in: ["ImagingOrder", "ImagingStudy"] },
    });
  }
  return filters;
}

function assertHieDeploymentReady(config: EffectiveHieConfig) {
  const deploymentEnvironment = process.env.HIE_DEPLOYMENT_ENVIRONMENT;
  if (
    deploymentEnvironment !== "TEST" &&
    deploymentEnvironment !== "PRODUCTION"
  ) {
    throw new AppError({
      status: 409,
      code: "HIE_DEPLOYMENT_ENVIRONMENT_NOT_CONFIGURED",
      message:
        "Configure HIE_DEPLOYMENT_ENVIRONMENT before activating the integration",
      exposeMessage: true,
    });
  }
  if (config.environment !== deploymentEnvironment) {
    throw new AppError({
      status: 409,
      code: "HIE_ENVIRONMENT_MISMATCH",
      message:
        "The tenant HIE environment must match this CareLogic deployment",
      exposeMessage: true,
    });
  }
  if (
    !(
      process.env.HIE_BASIC_AUTH_USERNAME?.trim() &&
      process.env.HIE_BASIC_AUTH_PASSWORD
    )
  ) {
    throw new AppError({
      status: 409,
      code: "HIE_CREDENTIALS_NOT_CONFIGURED",
      message: "Configure HIE credentials before activating the integration",
      exposeMessage: true,
    });
  }
}

function assertHieEndpointsReady(config: EffectiveHieConfig) {
  const clientUrl = process.env.HIE_CLIENT_REGISTRY_BASE_URL;
  const shrUrl = process.env.HIE_SHR_BASE_URL;
  const shrEnabled = sharedRecordCapabilityEnabled(config);
  if (config.clientRegistryEnabled && !clientUrl) {
    throw new AppError({
      status: 409,
      code: "HIE_CLIENT_REGISTRY_NOT_CONFIGURED",
      message: "Configure the Client Registry endpoint before activation",
      exposeMessage: true,
    });
  }
  if (shrEnabled && !shrUrl) {
    throw new AppError({
      status: 409,
      code: "HIE_SHR_NOT_CONFIGURED",
      message: "Configure the Shared Health Record endpoint before activation",
      exposeMessage: true,
    });
  }
  if (config.environment !== "PRODUCTION") {
    return;
  }
  const insecureClientRegistry =
    config.clientRegistryEnabled && !clientUrl?.startsWith("https://");
  const insecureSharedRecord = shrEnabled && !shrUrl?.startsWith("https://");
  if (insecureClientRegistry || insecureSharedRecord) {
    throw new AppError({
      status: 409,
      code: "HIE_PRODUCTION_SECURE_TRANSPORT_REQUIRED",
      message: "Production HIE capabilities require HTTPS endpoints",
      exposeMessage: true,
    });
  }
}

function assertHieActivationReady(config: EffectiveHieConfig) {
  if (!config.enabled) {
    return;
  }
  assertHieEncryptionConfigured();
  assertHieDeploymentReady(config);
  assertHieEndpointsReady(config);
}

async function refreshHieHealth(config: {
  clinicId: number;
  environment: "TEST" | "PRODUCTION";
  enabled: boolean;
  clientRegistryEnabled: boolean;
  sharedRecordReadEnabled: boolean;
  sharedRecordWriteEnabled: boolean;
  transferEnabled: boolean;
  consentSyncEnabled: boolean;
  consultationWriteEnabled: boolean;
  nationalListReadEnabled: boolean;
  nationalAuditReadEnabled: boolean;
  emergencyReadEnabled: boolean;
  allergyWriteEnabled: boolean;
  immunizationWriteEnabled: boolean;
  imagingWriteEnabled: boolean;
  lastHealthStatus: string | null;
  lastHealthCheckedAt: Date | null;
}) {
  const stillFresh =
    config.lastHealthCheckedAt &&
    config.lastHealthCheckedAt > new Date(Date.now() - 5 * 60_000);
  if (!config.enabled || stillFresh) {
    return config;
  }
  const probes: Promise<unknown>[] = [];
  if (config.clientRegistryEnabled) {
    probes.push(probeClientRegistry(config.environment));
  }
  if (
    config.sharedRecordReadEnabled ||
    config.sharedRecordWriteEnabled ||
    config.transferEnabled
  ) {
    probes.push(
      rhieRequest({
        service: "SHR",
        method: "GET",
        path: "metadata",
        tenantEnvironment: config.environment,
      }).then((response) => capabilityStatementSchema.parse(response.data))
    );
  }
  const results = await Promise.allSettled(probes);
  const lastHealthStatus =
    results.length > 0 &&
    results.every((result) => result.status === "fulfilled")
      ? "UP"
      : "DEGRADED";
  return db.hieTenantConfig.update({
    where: { clinicId: config.clinicId },
    data: { lastHealthStatus, lastHealthCheckedAt: new Date() },
  });
}

async function probeClientRegistry(
  tenantEnvironment: "TEST" | "PRODUCTION"
): Promise<void> {
  try {
    const response = await rhieRequest({
      service: "CLIENT_REGISTRY",
      method: "GET",
      path: "metadata",
      tenantEnvironment,
    });
    capabilityStatementSchema.parse(response.data);
  } catch (error) {
    const metadataUnavailable =
      error instanceof RhieRequestError &&
      (error.status === 401 || error.status === 404);
    if (!metadataUnavailable) {
      throw error;
    }
    const response = await rhieRequest({
      service: "CLIENT_REGISTRY",
      method: "GET",
      path: "Patient",
      tenantEnvironment,
      query: { identifier: "urn:carelogic:health-check" },
    });
    fhirBundleSchema.parse(response.data);
  }
}

function tenant(c: Context<AppEnv>) {
  const clinicId = c.get("clinicId");
  const user = c.get("user");
  if (!(clinicId && user)) {
    throw new AppError({
      status: 403,
      code: "HIE_TENANT_REQUIRED",
      message: "A clinic context is required",
    });
  }
  return { clinicId, user, actorId: Number(user.id) };
}

function branchAdminScope(user: ReturnType<typeof tenant>["user"]) {
  if (user.role !== "BRANCH_ADMIN") {
    return;
  }
  if (!user.branchId) {
    throw new AppError({
      status: 403,
      code: "HIE_BRANCH_CONTEXT_REQUIRED",
      message: "A branch context is required",
    });
  }
  return user.branchId;
}

function transferBranchScope(user: ReturnType<typeof tenant>["user"]) {
  if (!["BRANCH_ADMIN", "DOCTOR"].includes(user.role)) {
    return;
  }
  if (!user.branchId) {
    throw new AppError({
      status: 403,
      code: "HIE_BRANCH_CONTEXT_REQUIRED",
      message: "A branch context is required",
    });
  }
  return user.branchId;
}

async function requireCapability(
  clinicId: number,
  capability:
    | "clientRegistryEnabled"
    | "sharedRecordReadEnabled"
    | "sharedRecordWriteEnabled"
    | "transferEnabled"
    | "consentSyncEnabled"
    | "consultationWriteEnabled"
    | "nationalListReadEnabled"
    | "nationalAuditReadEnabled"
    | "emergencyReadEnabled"
    | "allergyWriteEnabled"
    | "immunizationWriteEnabled"
    | "imagingWriteEnabled"
) {
  const config = await db.hieTenantConfig.findUnique({ where: { clinicId } });
  if (!(config?.enabled && config[capability])) {
    throw new AppError({
      status: 403,
      code: "HIE_CAPABILITY_DISABLED",
      message: "This HIE capability is not enabled for the clinic",
      exposeMessage: true,
    });
  }
  return config;
}

async function resumeReferenceBlockedEvents(
  clinicId: number,
  errorCodes: string[]
) {
  await db.hieOutboxEvent.updateMany({
    where: {
      clinicId,
      status: "BLOCKED",
      lastErrorCode: { in: errorCodes },
    },
    data: {
      status: "PENDING",
      dependencyReason: null,
      nextAttemptAt: new Date(),
      lockedAt: null,
    },
  });
}

async function scopedPatient(clinicId: number, patientId: number) {
  const patient = await db.patient.findFirst({
    where: { id: patientId, clinics: { some: { id: clinicId } } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      dateOfBirth: true,
      gender: true,
      phoneNumber: true,
      email: true,
      address: true,
      updatedAt: true,
    },
  });
  if (!patient) {
    throw notFoundError("Patient not found");
  }
  return patient;
}

function activeConsentWhere(clinicId: number, patientId: number, now: Date) {
  return {
    clinicId,
    patientId,
    status: "ACTIVE" as const,
    syncStatus: "SYNCED" as const,
    effectiveFrom: { lte: now },
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
  };
}

async function requireActiveConsent(clinicId: number, patientId: number) {
  const consent = await db.hieConsent.findFirst({
    where: activeConsentWhere(clinicId, patientId, new Date()),
    select: { id: true },
  });
  if (!consent) {
    throw new AppError({
      status: 403,
      code: "HIE_ACTIVE_CONSENT_REQUIRED",
      message: "Active patient consent is required for this HIE operation",
      exposeMessage: true,
    });
  }
  return consent;
}

async function audit(params: {
  clinicId: number;
  actorId: number;
  patientId?: number;
  action: string;
  capability: string;
  outcome: string;
  correlationId: string;
  metadata?: Record<string, string | number | boolean>;
}) {
  await db.hieAuditEvent.create({
    data: {
      clinicId: params.clinicId,
      actorId: params.actorId,
      patientId: params.patientId,
      action: params.action,
      capability: params.capability,
      purposeOfUse: "TREATMENT",
      outcome: params.outcome,
      correlationId: params.correlationId,
      metadata: params.metadata,
    },
  });
}

async function recordIdentityConflict(params: {
  clinicId: number;
  patientId: number;
  actorId: number;
  identifierHash: string;
  identifier: string;
}) {
  const conflictingIdentity = await db.patientExternalIdentity.findFirst({
    where: {
      identifierType: "NID",
      identifierHash: params.identifierHash,
    },
    select: { patientId: true },
  });
  await db.hieIdentityReconciliation.create({
    data: {
      clinicId: params.clinicId,
      patientId: params.patientId,
      conflictingPatientId: conflictingIdentity?.patientId,
      identifierType: "NID",
      identifierHash: params.identifierHash,
      identifierEncrypted: encryptHieValue(params.identifier),
      reasonCode: "IDENTIFIER_ALREADY_LINKED",
    },
  });
  await audit({
    clinicId: params.clinicId,
    actorId: params.actorId,
    patientId: params.patientId,
    action: "patient.identity.conflict",
    capability: "CLIENT_REGISTRY",
    outcome: "CONFLICT",
    correlationId: randomUUID(),
  });
}

class PatientIdentityConflictError extends Error {
  constructor() {
    super("National identity is linked to another patient");
    this.name = "PatientIdentityConflictError";
  }
}

function assertIdentityCanBeDeferred(
  identity: { patientId: number; verificationStatus: string } | null,
  patientId: number
) {
  if (identity && identity.patientId !== patientId) {
    throw new PatientIdentityConflictError();
  }
  if (identity?.verificationStatus === "VERIFIED") {
    throw new AppError({
      status: 409,
      code: "HIE_IDENTITY_ALREADY_VERIFIED",
      message: "A verified national identity cannot be deferred",
      exposeMessage: true,
    });
  }
}

async function throwRecordedIdentityConflict(params: {
  clinicId: number;
  patientId: number;
  actorId: number;
  identifierHash: string;
  identifier: string;
}): Promise<never> {
  await recordIdentityConflict(params);
  throw new AppError({
    status: 409,
    code: "HIE_IDENTITY_ALREADY_LINKED",
    message: "This national identity is already linked to another patient",
    exposeMessage: true,
  });
}

const IDENTITY_UNIQUE_FIELDS = ["identifierType", "identifierHash"];

/**
 * The identity writes below read the existing link and then upsert, so two
 * concurrent requests for the same identifier can both clear the check and race
 * into the `identifierType_identifierHash` unique index. Postgres rejects the
 * loser with P2002 — the same conflict the explicit check raises, so it has to be
 * recorded rather than escaping to the global handler as a bare
 * UNIQUE_CONSTRAINT_VIOLATION with no reconciliation row and no audit event.
 */
async function runPatientIdentityWrite<T>(
  operation: () => Promise<T>,
  conflict: Parameters<typeof throwRecordedIdentityConflict>[0]
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      !(
        error instanceof PatientIdentityConflictError ||
        isUniqueViolationOn(error, IDENTITY_UNIQUE_FIELDS)
      )
    ) {
      throw error;
    }
    return throwRecordedIdentityConflict(conflict);
  }
}

export async function getStatus(c: Context<AppEnv>): Promise<Response> {
  const { clinicId, user } = tenant(c);
  const branchId = branchAdminScope(user);
  const configWithClinic = await db.hieTenantConfig.findUnique({
    where: { clinicId },
    include: { clinic: { select: { branches: { select: { id: true } } } } },
  });
  const config = configWithClinic
    ? await refreshHieHealth(configWithClinic)
    : null;
  const facilities = await db.hieFacilityLink.count({
    where: {
      clinicId,
      verificationStatus: { in: ["VERIFIED", "MANUAL_ATTESTED"] },
      ...(branchId ? { branchId } : {}),
    },
  });
  const visibleBranches = configWithClinic?.clinic.branches ?? [];
  const totalBranches = branchId
    ? Number(visibleBranches.some((branch) => branch.id === branchId))
    : visibleBranches.length;
  return jsonSuccess(c, {
    data: {
      configured: Boolean(config),
      enabled: config?.enabled ?? false,
      environment: config?.environment ?? null,
      capabilities: config
        ? {
            clientRegistry: config.clientRegistryEnabled,
            sharedRecordRead: config.sharedRecordReadEnabled,
            sharedRecordWrite: config.sharedRecordWriteEnabled,
            transfer: config.transferEnabled,
            consentSync: config.consentSyncEnabled,
            consultationWrite: config.consultationWriteEnabled,
            nationalListRead: config.nationalListReadEnabled,
            nationalAuditRead: config.nationalAuditReadEnabled,
            emergencyRead: config.emergencyReadEnabled,
            allergyWrite: config.allergyWriteEnabled,
            immunizationWrite: config.immunizationWriteEnabled,
            imagingWrite: config.imagingWriteEnabled,
          }
        : null,
      verifiedFacilities: facilities,
      totalBranches,
      canManageConfig: user.role === "CLINIC_ADMIN",
      lastHealthStatus: config?.lastHealthStatus ?? null,
      lastHealthCheckedAt: config?.lastHealthCheckedAt ?? null,
    },
  });
}

export async function updateConfig(c: Context<AppEnv>): Promise<Response> {
  const { clinicId, actorId, user } = tenant(c);
  if (user.role !== "CLINIC_ADMIN") {
    throw new AppError({
      status: 403,
      code: "HIE_CONFIG_CLINIC_ADMIN_REQUIRED",
      message: "Only a clinic administrator can update HIE configuration",
      exposeMessage: true,
    });
  }
  const input = c.get("validatedJson") as ConfigInput;
  const existing = await db.hieTenantConfig.findUnique({ where: { clinicId } });
  const effective = effectiveHieConfig(input, existing);
  assertHieActivationReady(effective);
  const config = await db.$transaction(async (tx) => {
    const saved = await tx.hieTenantConfig.upsert({
      where: { clinicId },
      create: { clinicId, ...input },
      update: input,
    });
    const enabledResourceFilters = enabledPublicationResourceFilters(effective);
    if (effective.enabled && enabledResourceFilters.length > 0) {
      await tx.hieOutboxEvent.updateMany({
        where: {
          clinicId,
          status: "BLOCKED",
          lastErrorCode: "HIE_CAPABILITY_DISABLED",
          OR: enabledResourceFilters,
        },
        data: {
          status: "PENDING",
          dependencyReason: null,
          nextAttemptAt: new Date(),
          lockedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
    }
    return saved;
  });
  await audit({
    clinicId,
    actorId,
    action: "configuration.updated",
    capability: "CONFIGURATION",
    outcome: "SUCCESS",
    correlationId: randomUUID(),
  });
  return jsonSuccess(c, { data: config });
}

export async function getMappings(c: Context<AppEnv>): Promise<Response> {
  const { clinicId, user } = tenant(c);
  const branchId = branchAdminScope(user);
  const [branches, practitioners, destinations] = await Promise.all([
    db.branch.findMany({
      where: { clinicId, ...(branchId ? { id: branchId } : {}) },
      orderBy: [{ isHeadOffice: "desc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        code: true,
        isHeadOffice: true,
        hieFacilityLinks: {
          where: { clinicId },
          take: 1,
          select: {
            fosaCode: true,
            locationReference: true,
            displayName: true,
            verificationStatus: true,
            verifiedAt: true,
            lastRegistryCheckAt: true,
            verificationSource: true,
            verificationReference: true,
            verificationExpiresAt: true,
          },
        },
      },
    }),
    db.user.findMany({
      where: {
        clinicId,
        ...(branchId ? { branchId } : {}),
        role: {
          in: ["DOCTOR", "NURSE", "LAB_TECHNICIAN", "PHARMACIST"],
        },
      },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        role: true,
        licenseNumber: true,
        hieExternalIdentities: {
          where: { identifierType: "PRACTITIONER" },
          take: 1,
          select: {
            identifierEncrypted: true,
            verificationStatus: true,
            verifiedAt: true,
            verificationSource: true,
            verificationReference: true,
            verificationExpiresAt: true,
          },
        },
      },
    }),
    db.hieDestinationFacility.findMany({
      where: { clinicId },
      orderBy: { displayName: "asc" },
      select: {
        id: true,
        fosaCode: true,
        locationReference: true,
        displayName: true,
        verificationStatus: true,
        verifiedAt: true,
        verificationSource: true,
        verificationReference: true,
        verificationExpiresAt: true,
        updatedAt: true,
      },
    }),
  ]);
  return jsonSuccess(c, {
    data: {
      facilities: branches.map((branch) => ({
        id: branch.id,
        name: branch.name,
        code: branch.code,
        isHeadOffice: branch.isHeadOffice,
        mapping: branch.hieFacilityLinks[0] ?? null,
      })),
      practitioners: practitioners.map((practitioner) => {
        const identity = practitioner.hieExternalIdentities[0];
        return {
          id: practitioner.id,
          name: practitioner.name,
          role: practitioner.role,
          licenseNumber: practitioner.licenseNumber,
          mapping: identity
            ? {
                practitionerReference: `Practitioner/${decryptHieValue(
                  identity.identifierEncrypted
                )}`,
                verificationStatus: identity.verificationStatus,
                verifiedAt: identity.verifiedAt,
                verificationSource: identity.verificationSource,
                verificationReference: identity.verificationReference,
                verificationExpiresAt: identity.verificationExpiresAt,
              }
            : null,
        };
      }),
      destinations,
    },
  });
}

export async function upsertFacilityLink(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, actorId, user } = tenant(c);
  const branchId = branchAdminScope(user);
  const input = c.get("validatedJson") as FacilityInput;
  if (branchId && branchId !== input.branchId) {
    throw notFoundError("Branch not found");
  }
  const branch = await db.branch.findFirst({
    where: { id: input.branchId, clinicId },
    select: { id: true },
  });
  if (!branch) {
    throw notFoundError("Branch not found");
  }
  const link = await db.hieFacilityLink.upsert({
    where: { clinicId_branchId: { clinicId, branchId: input.branchId } },
    create: {
      clinicId,
      branchId: input.branchId,
      fosaCode: input.fosaCode,
      locationReference: input.locationReference,
      displayName: input.displayName,
      verificationStatus: input.verificationStatus,
      verificationSource: input.verificationSource,
      verificationReference: input.verificationReference,
      verificationActorId: actorId,
      verificationExpiresAt: new Date(input.verificationExpiresAt),
      verifiedAt:
        input.verificationStatus === "MANUAL_ATTESTED" ? new Date() : undefined,
    },
    update: {
      fosaCode: input.fosaCode,
      locationReference: input.locationReference,
      displayName: input.displayName,
      verificationStatus: input.verificationStatus,
      verificationSource: input.verificationSource,
      verificationReference: input.verificationReference,
      verificationActorId: actorId,
      verificationExpiresAt: new Date(input.verificationExpiresAt),
      verifiedAt:
        input.verificationStatus === "MANUAL_ATTESTED" ? new Date() : null,
    },
  });
  if (input.verificationStatus === "MANUAL_ATTESTED") {
    await resumeReferenceBlockedEvents(clinicId, [
      "FACILITY_IDENTITY_REQUIRED",
      "CLINICAL_REFERENCES_REQUIRED",
    ]);
  }
  await audit({
    clinicId,
    actorId,
    action: "facility.link.updated",
    capability: "FACILITY_REGISTRY",
    outcome: "SUCCESS",
    correlationId: randomUUID(),
    metadata: { branchId: input.branchId },
  });
  return jsonSuccess(c, { data: link });
}

export async function upsertPractitionerLink(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, actorId, user: actor } = tenant(c);
  const branchId = branchAdminScope(actor);
  const input = c.get("validatedJson") as PractitionerInput;
  const user = await db.user.findFirst({
    where: {
      id: input.userId,
      clinicId,
      ...(branchId ? { branchId } : {}),
    },
    select: { id: true },
  });
  if (!user) {
    throw notFoundError("User not found");
  }
  const practitionerId = input.practitionerReference.slice(
    "Practitioner/".length
  );
  const identifierHash = hashHieIdentifier(practitionerId);
  const existing = await db.userExternalIdentity.findUnique({
    where: {
      identifierType_identifierHash: {
        identifierType: "PRACTITIONER",
        identifierHash,
      },
    },
    select: { userId: true },
  });
  if (existing && existing.userId !== input.userId) {
    throw new AppError({
      status: 409,
      code: "HIE_PRACTITIONER_ALREADY_LINKED",
      message: "This national practitioner is already linked to another user",
      exposeMessage: true,
    });
  }
  const identity = await db.userExternalIdentity.upsert({
    where: {
      identifierType_identifierHash: {
        identifierType: "PRACTITIONER",
        identifierHash,
      },
    },
    create: {
      userId: input.userId,
      identifierType: "PRACTITIONER",
      identifierHash,
      identifierEncrypted: encryptHieValue(practitionerId),
      verificationStatus: input.verificationStatus,
      verificationSource: input.verificationSource,
      verificationReference: input.verificationReference,
      verificationActorId: actorId,
      verificationExpiresAt: new Date(input.verificationExpiresAt),
      verifiedAt:
        input.verificationStatus === "MANUAL_ATTESTED" ? new Date() : undefined,
    },
    update: {
      userId: input.userId,
      identifierEncrypted: encryptHieValue(practitionerId),
      verificationStatus: input.verificationStatus,
      verificationSource: input.verificationSource,
      verificationReference: input.verificationReference,
      verificationActorId: actorId,
      verificationExpiresAt: new Date(input.verificationExpiresAt),
      verifiedAt:
        input.verificationStatus === "MANUAL_ATTESTED" ? new Date() : null,
    },
    select: {
      id: true,
      userId: true,
      identifierType: true,
      verificationStatus: true,
      verifiedAt: true,
    },
  });
  if (input.verificationStatus === "MANUAL_ATTESTED") {
    await resumeReferenceBlockedEvents(clinicId, [
      "PRACTITIONER_IDENTITY_REQUIRED",
      "CLINICAL_REFERENCES_REQUIRED",
    ]);
  }
  await audit({
    clinicId,
    actorId,
    action: "practitioner.link.updated",
    capability: "PRACTITIONER_REGISTRY",
    outcome: "SUCCESS",
    correlationId: randomUUID(),
    metadata: { userId: input.userId },
  });
  return jsonSuccess(c, { data: identity });
}

export async function upsertDestinationFacility(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, actorId, user } = tenant(c);
  if (user.role !== "CLINIC_ADMIN") {
    throw new AppError({
      status: 403,
      code: "HIE_DESTINATION_CLINIC_ADMIN_REQUIRED",
      message: "Only a clinic administrator can manage HIE destinations",
      exposeMessage: true,
    });
  }
  const input = c.get("validatedJson") as DestinationFacilityInput;
  const existing = input.id
    ? await db.hieDestinationFacility.findFirst({
        where: { id: input.id, clinicId },
        select: { id: true },
      })
    : null;
  if (input.id && !existing) {
    throw notFoundError("HIE destination facility not found");
  }
  const destination = existing
    ? await db.hieDestinationFacility.update({
        where: { id: existing.id },
        data: {
          fosaCode: input.fosaCode,
          locationReference: input.locationReference,
          displayName: input.displayName,
          verificationStatus: input.verificationStatus,
          verificationSource: input.verificationSource,
          verificationReference: input.verificationReference,
          verificationActorId: actorId,
          verificationExpiresAt: new Date(input.verificationExpiresAt),
          verifiedAt:
            input.verificationStatus === "MANUAL_ATTESTED" ? new Date() : null,
        },
      })
    : await db.hieDestinationFacility.create({
        data: {
          clinicId,
          fosaCode: input.fosaCode,
          locationReference: input.locationReference,
          displayName: input.displayName,
          verificationStatus: input.verificationStatus,
          verificationSource: input.verificationSource,
          verificationReference: input.verificationReference,
          verificationActorId: actorId,
          verificationExpiresAt: new Date(input.verificationExpiresAt),
          verifiedAt:
            input.verificationStatus === "MANUAL_ATTESTED"
              ? new Date()
              : undefined,
        },
      });
  await audit({
    clinicId,
    actorId,
    action: "destination-facility.updated",
    capability: "FACILITY_REGISTRY",
    outcome: input.verificationStatus,
    correlationId: randomUUID(),
    metadata: { destinationFacilityId: destination.id },
  });
  return jsonSuccess(c, { data: destination });
}

export async function lookupPatient(c: Context<AppEnv>): Promise<Response> {
  const { clinicId, actorId } = tenant(c);
  const config = await requireCapability(clinicId, "clientRegistryEnabled");
  const input = c.get("validatedJson") as LookupInput;
  const result = await lookupNationalPatient({
    ...input,
    tenantEnvironment: config.environment,
  });
  const candidateSelect = {
    id: true,
    firstName: true,
    lastName: true,
    dateOfBirth: true,
    gender: true,
    phoneNumber: true,
    email: true,
    address: true,
    updatedAt: true,
  } satisfies Prisma.PatientSelect;
  const identifierHash = hashHieIdentifier(input.nid);
  const linkedCandidates = await db.patient.findMany({
    where: {
      clinics: { some: { id: clinicId } },
      externalIdentities: {
        some: {
          identifierType: "NID",
          identifierHash,
          verificationStatus: "VERIFIED",
        },
      },
    },
    take: 10,
    select: candidateSelect,
  });
  const demographicCandidates = result.matches.length
    ? await db.patient.findMany({
        where: {
          clinics: { some: { id: clinicId } },
          dateOfBirth: birthDateStorageWindow(input.birthDate),
          OR: result.matches.map((match) => ({
            firstName: { equals: match.firstName, mode: "insensitive" },
            lastName: { equals: match.lastName, mode: "insensitive" },
          })),
        },
        take: 10,
        select: candidateSelect,
      })
    : [];
  const localCandidates = prioritizeLinkedCandidates(
    linkedCandidates,
    demographicCandidates
  );
  await audit({
    clinicId,
    actorId,
    action: "patient.lookup",
    capability: "CLIENT_REGISTRY",
    outcome: "SUCCESS",
    correlationId: result.correlationId,
    metadata: {
      matchCount: result.matches.length,
      localCandidateCount: localCandidates.length,
    },
  });
  return jsonSuccess(c, {
    data: {
      matches: result.matches,
      localCandidates,
      correlationId: result.correlationId,
    },
  });
}

async function linkVerifiedUpid(
  tx: Prisma.TransactionClient,
  params: {
    patientId: number;
    upid: string;
    externalPatientId: string;
    resourceHash: string;
    snapshot: unknown;
  }
) {
  const upidHash = hashHieIdentifier(params.upid);
  const conflictingUpid = await tx.patientExternalIdentity.findUnique({
    where: {
      identifierType_identifierHash: {
        identifierType: "UPID",
        identifierHash: upidHash,
      },
    },
    select: { patientId: true },
  });
  if (conflictingUpid && conflictingUpid.patientId !== params.patientId) {
    throw new PatientIdentityConflictError();
  }
  await tx.patientExternalIdentity.upsert({
    where: {
      identifierType_identifierHash: {
        identifierType: "UPID",
        identifierHash: upidHash,
      },
    },
    create: {
      patientId: params.patientId,
      identifierType: "UPID",
      identifierHash: upidHash,
      identifierEncrypted: encryptHieValue(params.upid),
      resourceIdHash: params.resourceHash,
      resourceIdEncrypted: encryptHieValue(params.externalPatientId),
      verificationStatus: "VERIFIED",
      verifiedAt: new Date(),
      demographicsSnapshotEncrypted: encryptHieJson(params.snapshot),
    },
    update: {
      resourceIdHash: params.resourceHash,
      resourceIdEncrypted: encryptHieValue(params.externalPatientId),
      verificationStatus: "VERIFIED",
      verifiedAt: new Date(),
      deferredReason: null,
      retryCount: 0,
      nextRetryAt: null,
      lastErrorCode: null,
      demographicsSnapshotEncrypted: encryptHieJson(params.snapshot),
    },
  });
}

export async function linkPatient(c: Context<AppEnv>): Promise<Response> {
  const { clinicId, actorId } = tenant(c);
  const config = await requireCapability(clinicId, "clientRegistryEnabled");
  const input = c.get("validatedJson") as LinkInput;
  const patient = await scopedPatient(clinicId, input.patientId);
  if (patient.updatedAt.toISOString() !== input.expectedPatientUpdatedAt) {
    throw new AppError({
      status: 409,
      code: "PATIENT_CHANGED",
      message:
        "Patient details changed; review the latest values before linking",
      exposeMessage: true,
    });
  }
  const lookup = await lookupNationalPatient({
    nid: input.nid,
    birthDate: input.birthDate,
    tenantEnvironment: config.environment,
  });
  const nationalPatient = lookup.matches.find(
    (match) => match.externalPatientId === input.externalPatientId
  );
  if (!nationalPatient) {
    throw new AppError({
      status: 409,
      code: "HIE_PATIENT_MATCH_CHANGED",
      message: "The selected national patient match is no longer available",
      exposeMessage: true,
    });
  }
  const identifierHash = hashHieIdentifier(input.nid);
  const snapshot = {
    nationalPatient,
    reviewedFields: input.reviewedFields,
    linkedAgainstPatientUpdatedAt: input.expectedPatientUpdatedAt,
  };
  const resourceHash = hashHieIdentifier(input.externalPatientId);
  const identity = await runPatientIdentityWrite(
    () =>
      db.$transaction(async (tx) => {
        const conflictingLink = await tx.patientExternalIdentity.findUnique({
          where: {
            identifierType_identifierHash: {
              identifierType: "NID",
              identifierHash,
            },
          },
          select: { patientId: true },
        });
        if (conflictingLink && conflictingLink.patientId !== input.patientId) {
          throw new PatientIdentityConflictError();
        }
        const linkedIdentity = await tx.patientExternalIdentity.upsert({
          where: {
            identifierType_identifierHash: {
              identifierType: "NID",
              identifierHash,
            },
          },
          create: {
            patientId: input.patientId,
            identifierType: "NID",
            identifierHash,
            identifierEncrypted: encryptHieValue(input.nid),
            resourceIdHash: resourceHash,
            resourceIdEncrypted: encryptHieValue(input.externalPatientId),
            verificationStatus: "VERIFIED",
            verifiedAt: new Date(),
            demographicsSnapshotEncrypted: encryptHieJson(snapshot),
          },
          update: {
            resourceIdHash: resourceHash,
            resourceIdEncrypted: encryptHieValue(input.externalPatientId),
            verificationStatus: "VERIFIED",
            verifiedAt: new Date(),
            deferredReason: null,
            retryCount: 0,
            nextRetryAt: null,
            lastAttemptAt: new Date(),
            lastErrorCode: null,
            demographicsSnapshotEncrypted: encryptHieJson(snapshot),
          },
          select: {
            id: true,
            patientId: true,
            identifierType: true,
            verificationStatus: true,
            verifiedAt: true,
          },
        });
        if (linkedIdentity.patientId !== input.patientId) {
          throw new PatientIdentityConflictError();
        }
        if (nationalPatient.upid) {
          await linkVerifiedUpid(tx, {
            patientId: input.patientId,
            upid: nationalPatient.upid,
            externalPatientId: input.externalPatientId,
            resourceHash,
            snapshot,
          });
        }
        if (nationalPatient.structuredAddress) {
          await tx.patient.update({
            where: { id: input.patientId },
            data: { structuredAddress: nationalPatient.structuredAddress },
          });
        }
        await resumeBlockedPatientEvents(tx, {
          clinicId,
          patientId: input.patientId,
        });
        return linkedIdentity;
      }),
    {
      clinicId,
      patientId: input.patientId,
      actorId,
      identifierHash,
      identifier: input.nid,
    }
  );
  await audit({
    clinicId,
    actorId,
    patientId: input.patientId,
    action: "patient.link",
    capability: "CLIENT_REGISTRY",
    outcome: "SUCCESS",
    correlationId: lookup.correlationId,
    metadata: { reviewedFieldCount: input.reviewedFields.length },
  });
  return jsonSuccess(c, { data: identity });
}

export async function deferVerification(c: Context<AppEnv>): Promise<Response> {
  const { clinicId, actorId } = tenant(c);
  await requireCapability(clinicId, "clientRegistryEnabled");
  const input = c.get("validatedJson") as DeferInput;
  await scopedPatient(clinicId, input.patientId);
  const identifierHash = hashHieIdentifier(input.nid);
  const identity = await runPatientIdentityWrite(
    () =>
      db.$transaction(async (tx) => {
        const conflictingLink = await tx.patientExternalIdentity.findUnique({
          where: {
            identifierType_identifierHash: {
              identifierType: "NID",
              identifierHash,
            },
          },
          select: { patientId: true, verificationStatus: true },
        });
        assertIdentityCanBeDeferred(conflictingLink, input.patientId);
        const deferredIdentity = await tx.patientExternalIdentity.upsert({
          where: {
            identifierType_identifierHash: {
              identifierType: "NID",
              identifierHash,
            },
            verificationStatus: { not: "VERIFIED" },
          },
          create: {
            patientId: input.patientId,
            identifierType: "NID",
            identifierHash,
            identifierEncrypted: encryptHieValue(input.nid),
            verificationStatus: "PENDING",
            deferredReason: input.note
              ? `${input.reason}: ${input.note}`
              : input.reason,
            demographicsSnapshotEncrypted: encryptHieJson({
              birthDate: input.birthDate,
            }),
            nextRetryAt: new Date(),
          },
          update: {
            verificationStatus: "PENDING",
            deferredReason: input.note
              ? `${input.reason}: ${input.note}`
              : input.reason,
            nextRetryAt: new Date(),
            lastErrorCode: null,
          },
          select: {
            id: true,
            patientId: true,
            identifierType: true,
            verificationStatus: true,
          },
        });
        if (deferredIdentity.patientId !== input.patientId) {
          throw new PatientIdentityConflictError();
        }
        return deferredIdentity;
      }),
    {
      clinicId,
      patientId: input.patientId,
      actorId,
      identifierHash,
      identifier: input.nid,
    }
  );
  await audit({
    clinicId,
    actorId,
    patientId: input.patientId,
    action: "patient.verification.deferred",
    capability: "CLIENT_REGISTRY",
    outcome: "PENDING",
    correlationId: randomUUID(),
  });
  return jsonSuccess(c, { status: 202, data: identity });
}

export async function getPatientIps(c: Context<AppEnv>): Promise<Response> {
  const { clinicId, actorId } = tenant(c);
  const config = await requireCapability(clinicId, "sharedRecordReadEnabled");
  const patientId = Number(c.req.param("patientId"));
  await scopedPatient(clinicId, patientId);
  await requireActiveConsent(clinicId, patientId);
  const identity = await db.patientExternalIdentity.findFirst({
    where: { patientId, verificationStatus: "VERIFIED" },
    orderBy: [{ identifierType: "asc" }, { verifiedAt: "desc" }],
  });
  if (!identity?.resourceIdEncrypted) {
    throw new AppError({
      status: 409,
      code: "HIE_PATIENT_NOT_LINKED",
      message:
        "Link the patient to the Client Registry before retrieving records",
      exposeMessage: true,
    });
  }
  const summary = await getInternationalPatientSummaryView(
    decryptHieValue(identity.resourceIdEncrypted),
    patientId,
    config.environment
  );
  const resourceHashes = summary.items.flatMap((item) =>
    item.resourceId
      ? [hashHieIdentifier(`${item.resourceType}/${item.resourceId}`)]
      : []
  );
  const reconciliations = resourceHashes.length
    ? await db.hieReconciliation.findMany({
        where: {
          clinicId,
          patientId,
          externalResourceIdHash: { in: resourceHashes },
        },
        select: {
          externalResourceType: true,
          externalResourceIdHash: true,
          status: true,
          reviewedAt: true,
          notes: true,
          localResourceType: true,
          localResourceId: true,
          reviewedBy: { select: { name: true } },
        },
      })
    : [];
  const reconciliationByResource = new Map(
    reconciliations.map((item) => [
      `${item.externalResourceType}:${item.externalResourceIdHash}`,
      item,
    ])
  );
  const items = summary.items.map((item) => {
    const resourceHash = item.resourceId
      ? hashHieIdentifier(`${item.resourceType}/${item.resourceId}`)
      : null;
    const reconciliation = resourceHash
      ? reconciliationByResource.get(`${item.resourceType}:${resourceHash}`)
      : undefined;
    return {
      ...item,
      reconciliationStatus: reconciliation?.status ?? "PENDING",
      reviewedAt: reconciliation?.reviewedAt ?? null,
      reconciliationNotes: reconciliation?.notes ?? null,
      reconciledBy: reconciliation?.reviewedBy?.name ?? null,
      localResourceType: reconciliation?.localResourceType ?? null,
      localResourceId: reconciliation?.localResourceId ?? null,
    };
  });
  await audit({
    clinicId,
    actorId,
    patientId,
    action: "patient.ips.read",
    capability: "SHARED_RECORD",
    outcome: "SUCCESS",
    correlationId: summary.correlationId,
    metadata: { resourceCount: items.length },
  });
  return jsonSuccess(c, { data: { ...summary, items } });
}

export async function getPatientNationalRecord(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, actorId } = tenant(c);
  const config = await requireCapability(clinicId, "nationalListReadEnabled");
  const patientId = Number(c.req.param("patientId"));
  const query = c.get("validatedQuery") as NationalRecordQuery;
  await scopedPatient(clinicId, patientId);
  await requireActiveConsent(clinicId, patientId);
  const identity = await db.patientExternalIdentity.findFirst({
    where: {
      patientId,
      verificationStatus: "VERIFIED",
      resourceIdEncrypted: { not: null },
    },
    orderBy: { verifiedAt: "desc" },
  });
  if (!identity?.resourceIdEncrypted) {
    throw new AppError({
      status: 409,
      code: "HIE_PATIENT_NOT_LINKED",
      message: "Link the patient before retrieving the national record",
      exposeMessage: true,
    });
  }
  const result = await retrieveNationalRecord({
    sections: query.sections,
    patientReference: decryptHieValue(identity.resourceIdEncrypted),
    patientId,
    tenantEnvironment: config.environment,
  });
  const returnedItems = result.sections.flatMap((section) => section.items);
  const hashes = returnedItems.flatMap((item) =>
    item.resourceId
      ? [hashHieIdentifier(`${item.resourceType}/${item.resourceId}`)]
      : []
  );
  const decisions = hashes.length
    ? await db.hieReconciliation.findMany({
        where: { clinicId, patientId, externalResourceIdHash: { in: hashes } },
        select: {
          externalResourceType: true,
          externalResourceIdHash: true,
          status: true,
          reviewedAt: true,
          notes: true,
          localResourceType: true,
          localResourceId: true,
          reviewedBy: { select: { name: true } },
        },
      })
    : [];
  const byResource = new Map(
    decisions.map((decision) => [
      `${decision.externalResourceType}:${decision.externalResourceIdHash}`,
      decision,
    ])
  );
  const sections = result.sections.map((section) => ({
    ...section,
    items: section.items.map((item) => {
      const hash = item.resourceId
        ? hashHieIdentifier(`${item.resourceType}/${item.resourceId}`)
        : null;
      const decision = hash
        ? byResource.get(`${item.resourceType}:${hash}`)
        : undefined;
      return {
        ...item,
        reconciliationStatus: decision?.status ?? "PENDING",
        reviewedAt: decision?.reviewedAt ?? null,
        reconciliationNotes: decision?.notes ?? null,
        reconciledBy: decision?.reviewedBy?.name ?? null,
        localResourceType: decision?.localResourceType ?? null,
        localResourceId: decision?.localResourceId ?? null,
      };
    }),
  }));
  await audit({
    clinicId,
    actorId,
    patientId,
    action: "national-record.read",
    capability: "NATIONAL_LIST_READ",
    outcome: result.partial ? "PARTIAL" : "SUCCESS",
    correlationId: randomUUID(),
    metadata: {
      sectionCount: result.sections.length,
      failedSectionCount: result.sections.filter(
        (section) => section.status === "FAILED"
      ).length,
    },
  });
  return jsonSuccess(c, { data: { ...result, sections } });
}

export async function createEmergencyAccess(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, actorId, user } = tenant(c);
  const config = await requireCapability(clinicId, "emergencyReadEnabled");
  if (user.role !== "DOCTOR") {
    throw new AppError({
      status: 403,
      code: "HIE_EMERGENCY_ACCESS_DOCTOR_REQUIRED",
      message: "Only a doctor can initiate emergency national-record access",
      exposeMessage: true,
    });
  }
  const patientId = Number(c.req.param("patientId"));
  const input = c.get("validatedJson") as EmergencyAccessInput;
  await scopedPatient(clinicId, patientId);
  const branch = await db.branch.findFirst({
    where: { id: input.branchId, clinicId },
    select: { id: true },
  });
  if (!branch) {
    throw notFoundError("Branch not found");
  }
  const identity = await db.patientExternalIdentity.findFirst({
    where: {
      patientId,
      verificationStatus: "VERIFIED",
      resourceIdEncrypted: { not: null },
    },
    orderBy: { verifiedAt: "desc" },
  });
  if (!identity?.resourceIdEncrypted) {
    throw new AppError({
      status: 409,
      code: "HIE_PATIENT_NOT_LINKED",
      message: "Link the patient before emergency national-record access",
      exposeMessage: true,
    });
  }
  const effectiveFrom = new Date();
  const access = await db.hieEmergencyAccess.create({
    data: {
      clinicId,
      patientId,
      clinicianId: actorId,
      branchId: input.branchId,
      reasonCode: input.reasonCode,
      justification: input.justification,
      effectiveFrom,
      effectiveTo: new Date(effectiveFrom.getTime() + 4 * 60 * 60_000),
      outcome: "GRANTED",
    },
  });
  const record = await retrieveNationalRecord({
    sections: nationalRecordSectionSchema.options,
    patientReference: decryptHieValue(identity.resourceIdEncrypted),
    patientId,
    tenantEnvironment: config.environment,
  });
  await audit({
    clinicId,
    actorId,
    patientId,
    action: "emergency-access.created",
    capability: "EMERGENCY_READ",
    outcome: record.partial ? "PARTIAL" : "SUCCESS",
    correlationId: randomUUID(),
    metadata: { emergencyAccessId: access.id },
  });
  return jsonSuccess(c, { status: 201, data: { access, record } });
}

export async function listEmergencyAccess(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, user } = tenant(c);
  if (user.role !== "CLINIC_ADMIN") {
    throw new AppError({
      status: 403,
      code: "HIE_EMERGENCY_REVIEW_CLINIC_ADMIN_REQUIRED",
      message: "Only a clinic administrator can review emergency access",
      exposeMessage: true,
    });
  }
  const query = c.get("validatedQuery") as EmergencyAccessQuery;
  const reviewDeadline = new Date(Date.now() - 24 * 60 * 60_000);
  const where = {
    clinicId,
    reviewStatus: query.reviewStatus,
    ...(query.overdue
      ? { reviewStatus: "PENDING" as const, createdAt: { lt: reviewDeadline } }
      : {}),
  };
  const [items, totalCount] = await Promise.all([
    db.hieEmergencyAccess.findMany({
      where,
      select: {
        id: true,
        patientId: true,
        reasonCode: true,
        justification: true,
        effectiveFrom: true,
        effectiveTo: true,
        outcome: true,
        reviewStatus: true,
        reviewedAt: true,
        reviewNote: true,
        createdAt: true,
        patient: { select: { firstName: true, lastName: true } },
        clinician: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
        reviewedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page,
    }),
    db.hieEmergencyAccess.count({ where }),
  ]);
  return jsonSuccess(c, {
    data: items.map((item) => ({
      ...item,
      reviewOverdue:
        item.reviewStatus === "PENDING" && item.createdAt < reviewDeadline,
    })),
    meta: {
      page: query.page,
      perPage: query.per_page,
      totalCount,
      pageCount: Math.ceil(totalCount / query.per_page),
    },
  });
}

export async function reviewEmergencyAccess(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, actorId, user } = tenant(c);
  if (user.role !== "CLINIC_ADMIN") {
    throw new AppError({
      status: 403,
      code: "HIE_EMERGENCY_REVIEW_CLINIC_ADMIN_REQUIRED",
      message: "Only a clinic administrator can review emergency access",
      exposeMessage: true,
    });
  }
  const id = Number(c.req.param("id"));
  const input = c.get("validatedJson") as EmergencyAccessReviewInput;
  const result = await db.hieEmergencyAccess.updateMany({
    where: { id, clinicId, reviewStatus: "PENDING" },
    data: {
      reviewStatus: input.status,
      reviewNote: input.note,
      reviewedById: actorId,
      reviewedAt: new Date(),
    },
  });
  if (result.count !== 1) {
    throw notFoundError("Pending emergency access review not found");
  }
  await audit({
    clinicId,
    actorId,
    action: "emergency-access.reviewed",
    capability: "EMERGENCY_READ",
    outcome: input.status,
    correlationId: randomUUID(),
    metadata: { emergencyAccessId: id },
  });
  return jsonSuccess(c, { data: { id, reviewStatus: input.status } });
}

export async function createConsent(c: Context<AppEnv>): Promise<Response> {
  const { clinicId, actorId } = tenant(c);
  const input = c.get("validatedJson") as ConsentInput;
  await scopedPatient(clinicId, input.patientId);
  const config = await db.hieTenantConfig.findUnique({
    where: { clinicId },
    select: {
      enabled: true,
      consentSyncEnabled: true,
      environment: true,
    },
  });
  const consent = await db.$transaction(async (tx) => {
    const superseded = await tx.hieConsent.findMany({
      where: {
        clinicId,
        patientId: input.patientId,
        scope: input.scope,
        status: "ACTIVE",
      },
    });
    await tx.hieConsent.updateMany({
      where: {
        clinicId,
        patientId: input.patientId,
        scope: input.scope,
        status: "ACTIVE",
      },
      data: {
        status: "INACTIVE",
        withdrawnAt: new Date(),
        withdrawnReason: "SUPERSEDED",
      },
    });
    if (config?.enabled && config.consentSyncEnabled) {
      for (const prior of superseded) {
        if (!prior.hieResourceIdEncrypted) {
          await tx.hieOutboxEvent.updateMany({
            where: {
              clinicId,
              aggregateType: "HieConsent",
              aggregateId: String(prior.id),
              operation: "CREATE",
              status: { in: ["PENDING", "RETRY", "BLOCKED"] },
            },
            data: {
              status: "DEAD_LETTER",
              completedAt: new Date(),
              lastErrorCode: "CONSENT_SUPERSEDED_BEFORE_SYNC",
              lastErrorMessage:
                "Consent was superseded before national synchronization",
            },
          });
          continue;
        }
        await tx.hieOutboxEvent.create({
          data: {
            clinicId,
            aggregateType: "HieConsent",
            aggregateId: String(prior.id),
            resourceType: "Consent",
            operation: "DELETE",
            dependencyOrder: 1,
            payloadEncrypted: encryptHieJson({
              consentId: prior.id,
              patientId: prior.patientId,
              scope: prior.scope,
              purpose: prior.purpose,
              recordedAt: prior.createdAt.toISOString(),
              hieResourceIdEncrypted: prior.hieResourceIdEncrypted,
            }),
            idempotencyKey: hieOutboxIdempotencyKey({
              environment: config.environment,
              clinicId,
              localResourceType: "HieConsent",
              localResourceId: String(prior.id),
              hieResourceType: "Consent",
              operation: "DELETE",
            }),
            correlationId: randomUUID(),
          },
        });
      }
    }
    const created = await tx.hieConsent.create({
      data: {
        clinicId,
        patientId: input.patientId,
        status: "ACTIVE",
        scope: input.scope,
        purpose: input.purpose,
        evidence: input.evidence as Prisma.InputJsonValue | undefined,
        effectiveFrom: new Date(input.effectiveFrom),
        effectiveTo: input.effectiveTo
          ? new Date(input.effectiveTo)
          : undefined,
        recordedById: actorId,
      },
    });
    if (config?.enabled && config.consentSyncEnabled) {
      await tx.hieOutboxEvent.create({
        data: {
          clinicId,
          aggregateType: "HieConsent",
          aggregateId: String(created.id),
          resourceType: "Consent",
          operation: "CREATE",
          dependencyOrder: 2,
          payloadEncrypted: encryptHieJson({
            consentId: created.id,
            patientId: created.patientId,
            scope: created.scope,
            purpose: created.purpose,
            recordedAt: created.createdAt.toISOString(),
          }),
          idempotencyKey: hieOutboxIdempotencyKey({
            environment: config.environment,
            clinicId,
            localResourceType: "HieConsent",
            localResourceId: String(created.id),
            hieResourceType: "Consent",
            operation: "CREATE",
          }),
          correlationId: randomUUID(),
        },
      });
    }
    return created;
  });
  await audit({
    clinicId,
    actorId,
    patientId: input.patientId,
    action: "consent.created",
    capability: "CONSENT",
    outcome: "SUCCESS",
    correlationId: randomUUID(),
  });
  return jsonSuccess(c, { status: 201, data: consent });
}

export async function getPatientConsent(c: Context<AppEnv>): Promise<Response> {
  const { clinicId } = tenant(c);
  const patientId = Number(c.req.param("patientId"));
  await scopedPatient(clinicId, patientId);
  const now = new Date();
  const [active, latest] = await Promise.all([
    db.hieConsent.findFirst({
      where: activeConsentWhere(clinicId, patientId, now),
      orderBy: { effectiveFrom: "desc" },
      select: {
        id: true,
        status: true,
        scope: true,
        purpose: true,
        effectiveFrom: true,
        effectiveTo: true,
        createdAt: true,
        syncStatus: true,
        synchronizedAt: true,
        lastSyncFailureCode: true,
      },
    }),
    db.hieConsent.findFirst({
      where: { clinicId, patientId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        scope: true,
        purpose: true,
        effectiveFrom: true,
        effectiveTo: true,
        withdrawnAt: true,
        withdrawnReason: true,
        createdAt: true,
        syncStatus: true,
        synchronizedAt: true,
        lastSyncFailureCode: true,
      },
    }),
  ]);
  return jsonSuccess(c, { data: { active, latest } });
}

function consentSyncOutcome(params: {
  localStatus: string;
  activeNational: boolean;
}): {
  syncStatus: "SYNCED" | "WITHDRAWN" | "FAILED";
  failureCode: string | null;
} {
  if (params.localStatus === "ACTIVE") {
    return params.activeNational
      ? { syncStatus: "SYNCED", failureCode: null }
      : { syncStatus: "FAILED", failureCode: "NATIONAL_CONSENT_INACTIVE" };
  }
  if (params.localStatus === "INACTIVE") {
    return params.activeNational
      ? {
          syncStatus: "FAILED",
          failureCode: "NATIONAL_CONSENT_WITHDRAWAL_REQUIRED",
        }
      : { syncStatus: "WITHDRAWN", failureCode: null };
  }
  return { syncStatus: "FAILED", failureCode: null };
}

function applyMatchedNationalConsent(params: {
  consentId: number;
  localStatus: string;
  activeNational: boolean;
}) {
  const outcome = consentSyncOutcome({
    localStatus: params.localStatus,
    activeNational: params.activeNational,
  });
  const now = new Date();
  return db.hieConsent.update({
    where: { id: params.consentId },
    data: {
      syncStatus: outcome.syncStatus,
      synchronizedAt: now,
      lastSyncAttemptAt: now,
      lastSyncFailureCode: outcome.failureCode,
      lastSyncFailureMessage: null,
    },
  });
}

function flagMissingNationalConsent(params: {
  clinicId: number;
  consentId: number;
}) {
  return db.$transaction([
    db.hieConsent.update({
      where: { id: params.consentId },
      data: {
        syncStatus: "FAILED",
        lastSyncAttemptAt: new Date(),
        lastSyncFailureCode: "NATIONAL_CONSENT_NOT_FOUND",
        lastSyncFailureMessage:
          "The previously synchronized consent is absent nationally",
      },
    }),
    db.hieOutboxEvent.updateMany({
      where: {
        clinicId: params.clinicId,
        aggregateType: "HieConsent",
        aggregateId: String(params.consentId),
        resourceType: "Consent",
        operation: "CREATE",
      },
      data: {
        status: "PENDING",
        completedAt: null,
        nextAttemptAt: new Date(),
        lockedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    }),
  ]);
}

async function reconcileLocalConsents<
  TNational extends { status?: string | null },
>(params: {
  clinicId: number;
  local: Array<{
    id: number;
    status: string;
    hieResourceIdEncrypted: string | null;
  }>;
  nationalById: Map<string, TNational>;
}) {
  let synchronized = 0;
  let missingNational = 0;
  for (const consent of params.local) {
    const nationalId = consent.hieResourceIdEncrypted
      ? decryptHieValue(consent.hieResourceIdEncrypted)
      : null;
    const match = nationalId ? params.nationalById.get(nationalId) : undefined;
    if (nationalId && match) {
      params.nationalById.delete(nationalId);
      await applyMatchedNationalConsent({
        consentId: consent.id,
        localStatus: consent.status,
        activeNational: match.status === "active",
      });
      synchronized += 1;
      continue;
    }
    if (nationalId && consent.status === "ACTIVE") {
      await flagMissingNationalConsent({
        clinicId: params.clinicId,
        consentId: consent.id,
      });
      missingNational += 1;
    }
  }
  return { synchronized, missingNational };
}

export async function reconcilePatientConsent(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, actorId } = tenant(c);
  const patientId = Number(c.req.param("patientId"));
  const config = await requireCapability(clinicId, "consentSyncEnabled");
  await scopedPatient(clinicId, patientId);
  const identity = await db.patientExternalIdentity.findFirst({
    where: {
      patientId,
      verificationStatus: "VERIFIED",
      resourceIdEncrypted: { not: null },
    },
    orderBy: { verifiedAt: "desc" },
  });
  if (!identity?.resourceIdEncrypted) {
    throw new AppError({
      status: 409,
      code: "HIE_PATIENT_NOT_LINKED",
      message: "Link the patient before reconciling national consent",
      exposeMessage: true,
    });
  }
  const response = await rhieRequest({
    service: "SHR",
    method: "GET",
    path: "Consent/$list-consents",
    tenantEnvironment: config.environment,
    query: { patient: decryptHieValue(identity.resourceIdEncrypted) },
  });
  const bundle = fhirBundleSchema.parse(response.data);
  const national = (bundle.entry ?? []).flatMap((entry) => {
    const parsed = fhirConsentSchema.safeParse(entry.resource);
    return parsed.success ? [parsed.data] : [];
  });
  const nationalById = new Map(
    national.flatMap((consent) => (consent.id ? [[consent.id, consent]] : []))
  );
  const local = await db.hieConsent.findMany({
    where: { clinicId, patientId },
    orderBy: { createdAt: "desc" },
  });
  const { synchronized, missingNational } = await reconcileLocalConsents({
    clinicId,
    local,
    nationalById,
  });
  await audit({
    clinicId,
    actorId,
    patientId,
    action: "consent.reconciled",
    capability: "CONSENT",
    outcome: missingNational > 0 ? "MISMATCH" : "SUCCESS",
    correlationId: randomUUID(),
    metadata: {
      synchronizedCount: synchronized,
      missingNationalCount: missingNational,
      nationalOnlyCount: nationalById.size,
    },
  });
  return jsonSuccess(c, {
    data: {
      synchronizedCount: synchronized,
      missingNationalCount: missingNational,
      nationalOnlyCount: nationalById.size,
      externalPrerequisite:
        nationalById.size > 0
          ? "National-only consents require administrative investigation"
          : null,
      environment: config.environment,
    },
  });
}

export async function withdrawConsent(c: Context<AppEnv>): Promise<Response> {
  const { clinicId, actorId } = tenant(c);
  const consentId = Number(c.req.param("consentId"));
  const input = c.get("validatedJson") as WithdrawConsentInput;
  const existing = await db.hieConsent.findFirst({
    where: { id: consentId, clinicId },
  });
  if (!existing) {
    throw notFoundError("Consent not found");
  }
  const config = await db.hieTenantConfig.findUnique({
    where: { clinicId },
    select: { enabled: true, consentSyncEnabled: true, environment: true },
  });
  const consent = await db.$transaction(async (tx) => {
    const nationallySynchronized = Boolean(existing.hieResourceIdEncrypted);
    const updated = await tx.hieConsent.update({
      where: { id: consentId },
      data: {
        status: "INACTIVE",
        syncStatus: nationallySynchronized ? "WITHDRAWAL_PENDING" : "WITHDRAWN",
        withdrawnAt: new Date(),
        withdrawnReason: input.reason,
      },
    });
    if (
      nationallySynchronized &&
      config?.enabled &&
      config.consentSyncEnabled
    ) {
      await tx.hieOutboxEvent.create({
        data: {
          clinicId,
          aggregateType: "HieConsent",
          aggregateId: String(existing.id),
          resourceType: "Consent",
          operation: "DELETE",
          dependencyOrder: 1,
          payloadEncrypted: encryptHieJson({
            consentId: existing.id,
            patientId: existing.patientId,
            scope: existing.scope,
            purpose: existing.purpose,
            recordedAt: existing.createdAt.toISOString(),
            hieResourceIdEncrypted: existing.hieResourceIdEncrypted,
          }),
          idempotencyKey: hieOutboxIdempotencyKey({
            environment: config.environment,
            clinicId,
            localResourceType: "HieConsent",
            localResourceId: String(existing.id),
            hieResourceType: "Consent",
            operation: "DELETE",
          }),
          correlationId: randomUUID(),
        },
      });
    } else {
      await tx.hieOutboxEvent.updateMany({
        where: {
          clinicId,
          aggregateType: "HieConsent",
          aggregateId: String(existing.id),
          resourceType: "Consent",
          operation: "CREATE",
          status: { in: ["PENDING", "RETRY", "BLOCKED"] },
        },
        data: {
          status: "DEAD_LETTER",
          lastErrorCode: "CONSENT_WITHDRAWN_BEFORE_SYNC",
          lastErrorMessage: "Consent was withdrawn before national sync",
          completedAt: new Date(),
        },
      });
    }
    return updated;
  });
  await audit({
    clinicId,
    actorId,
    patientId: existing.patientId,
    action: "consent.withdrawn",
    capability: "CONSENT",
    outcome: "SUCCESS",
    correlationId: randomUUID(),
  });
  return jsonSuccess(c, { data: consent });
}

export async function reconcileExternalResource(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, actorId } = tenant(c);
  const input = c.get("validatedJson") as ReconciliationInput;
  await scopedPatient(clinicId, input.patientId);
  const token = decodeReconciliationToken(input.reconciliationToken);
  if (new Date(token.expiresAt) <= new Date()) {
    throw new AppError({
      status: 410,
      code: "HIE_RECONCILIATION_TOKEN_EXPIRED",
      message: "Refresh the national record before recording a decision",
      exposeMessage: true,
    });
  }
  if (token.patientId !== input.patientId) {
    throw new AppError({
      status: 409,
      code: "HIE_RECONCILIATION_TOKEN_MISMATCH",
      message: "The reconciliation token does not belong to this patient",
      exposeMessage: true,
    });
  }
  const externalResourceIdHash = hashHieIdentifier(
    `${token.resourceType}/${token.resourceId}`
  );
  const reconciliation = await db.hieReconciliation.upsert({
    where: {
      clinicId_patientId_externalResourceType_externalResourceIdHash: {
        clinicId,
        patientId: input.patientId,
        externalResourceType: token.resourceType,
        externalResourceIdHash,
      },
    },
    create: {
      clinicId,
      patientId: input.patientId,
      externalResourceType: token.resourceType,
      externalResourceIdHash,
      externalResourceIdEncrypted: encryptHieValue(token.resourceId),
      status: input.status,
      reviewedById: actorId,
      reviewedAt: new Date(),
      notes: input.notes,
    },
    update: {
      status: input.status,
      reviewedById: actorId,
      reviewedAt: new Date(),
      notes: input.notes,
    },
  });
  await audit({
    clinicId,
    actorId,
    patientId: input.patientId,
    action: "external-resource.reconciled",
    capability: "SHARED_RECORD",
    outcome: input.status,
    correlationId: randomUUID(),
  });
  return jsonSuccess(c, { data: reconciliation });
}

export async function getPatientIdentityStatus(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId } = tenant(c);
  const patientId = Number(c.req.param("patientId"));
  await scopedPatient(clinicId, patientId);
  const identities = await db.patientExternalIdentity.findMany({
    where: { patientId },
    select: {
      id: true,
      identifierType: true,
      source: true,
      verificationStatus: true,
      verifiedAt: true,
      deferredReason: true,
      retryCount: true,
      nextRetryAt: true,
      lastAttemptAt: true,
      lastErrorCode: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: [{ verificationStatus: "asc" }, { updatedAt: "desc" }],
  });
  return jsonSuccess(c, { data: identities });
}

export async function listPendingIdentities(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId } = tenant(c);
  const query = c.get("validatedQuery") as IdentityQueueQuery;
  const where = {
    patient: { clinics: { some: { id: clinicId } } },
    verificationStatus: query.status ?? "PENDING",
  } as const;
  const [items, totalCount] = await Promise.all([
    db.patientExternalIdentity.findMany({
      where,
      select: {
        id: true,
        patientId: true,
        identifierType: true,
        verificationStatus: true,
        deferredReason: true,
        retryCount: true,
        nextRetryAt: true,
        lastAttemptAt: true,
        lastErrorCode: true,
        createdAt: true,
        updatedAt: true,
        patient: { select: { firstName: true, lastName: true } },
      },
      orderBy: [{ nextRetryAt: "asc" }, { createdAt: "asc" }],
      skip: (query.page - 1) * query.per_page,
      take: query.per_page,
    }),
    db.patientExternalIdentity.count({ where }),
  ]);
  return jsonSuccess(c, {
    data: items,
    meta: {
      page: query.page,
      perPage: query.per_page,
      totalCount,
      pageCount: Math.ceil(totalCount / query.per_page),
    },
  });
}

export async function retryPendingIdentity(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, actorId } = tenant(c);
  const config = await requireCapability(clinicId, "clientRegistryEnabled");
  const identityId = Number(c.req.param("identityId"));
  const identity = await db.patientExternalIdentity.findFirst({
    where: {
      id: identityId,
      verificationStatus: "PENDING",
      patient: { clinics: { some: { id: clinicId } } },
    },
  });
  if (!identity) {
    throw notFoundError("Pending identity not found");
  }
  const snapshot = pendingIdentitySnapshotSchema.parse(
    decryptHieJson(identity.demographicsSnapshotEncrypted ?? "")
  );
  const nid = decryptHieValue(identity.identifierEncrypted);
  try {
    const lookup = await lookupNationalPatient({
      nid,
      birthDate: snapshot.birthDate,
      tenantEnvironment: config.environment,
    });
    const match = lookup.matches[0];
    if (!match) {
      const updated = await db.patientExternalIdentity.update({
        where: { id: identity.id },
        data: {
          retryCount: { increment: 1 },
          lastAttemptAt: new Date(),
          nextRetryAt: new Date(Date.now() + 24 * 60 * 60_000),
          lastErrorCode: "HIE_PATIENT_NOT_FOUND",
        },
      });
      return jsonSuccess(c, { status: 202, data: updated });
    }
    const updated = await db.$transaction(async (tx) => {
      const verified = await tx.patientExternalIdentity.update({
        where: { id: identity.id },
        data: {
          resourceIdHash: hashHieIdentifier(match.externalPatientId),
          resourceIdEncrypted: encryptHieValue(match.externalPatientId),
          verificationStatus: "VERIFIED",
          verifiedAt: new Date(),
          deferredReason: null,
          retryCount: 0,
          nextRetryAt: null,
          lastAttemptAt: new Date(),
          lastErrorCode: null,
          demographicsSnapshotEncrypted: encryptHieJson({
            nationalPatient: match,
          }),
        },
      });
      if (match.upid) {
        const upidHash = hashHieIdentifier(match.upid);
        const existing = await tx.patientExternalIdentity.findUnique({
          where: {
            identifierType_identifierHash: {
              identifierType: "UPID",
              identifierHash: upidHash,
            },
          },
          select: { patientId: true },
        });
        if (existing && existing.patientId !== identity.patientId) {
          throw new PatientIdentityConflictError();
        }
        await tx.patientExternalIdentity.upsert({
          where: {
            identifierType_identifierHash: {
              identifierType: "UPID",
              identifierHash: upidHash,
            },
          },
          create: {
            patientId: identity.patientId,
            identifierType: "UPID",
            identifierHash: upidHash,
            identifierEncrypted: encryptHieValue(match.upid),
            resourceIdHash: hashHieIdentifier(match.externalPatientId),
            resourceIdEncrypted: encryptHieValue(match.externalPatientId),
            verificationStatus: "VERIFIED",
            verifiedAt: new Date(),
            demographicsSnapshotEncrypted: encryptHieJson({
              nationalPatient: match,
            }),
          },
          update: {
            verificationStatus: "VERIFIED",
            verifiedAt: new Date(),
            resourceIdHash: hashHieIdentifier(match.externalPatientId),
            resourceIdEncrypted: encryptHieValue(match.externalPatientId),
          },
        });
      }
      await resumeBlockedPatientEvents(tx, {
        clinicId,
        patientId: identity.patientId,
      });
      return verified;
    });
    await audit({
      clinicId,
      actorId,
      patientId: identity.patientId,
      action: "patient.verification.retried",
      capability: "CLIENT_REGISTRY",
      outcome: "VERIFIED",
      correlationId: lookup.correlationId,
    });
    return jsonSuccess(c, { data: updated });
  } catch (error) {
    if (error instanceof PatientIdentityConflictError) {
      await recordIdentityConflict({
        clinicId,
        patientId: identity.patientId,
        actorId,
        identifierHash: identity.identifierHash,
        identifier: nid,
      });
    }
    if (error instanceof RhieRequestError) {
      await db.patientExternalIdentity.update({
        where: { id: identity.id },
        data: {
          retryCount: { increment: 1 },
          lastAttemptAt: new Date(),
          nextRetryAt: new Date(Date.now() + 60 * 60_000),
          lastErrorCode: error.code,
        },
      });
    }
    throw error;
  }
}

export async function listIdentityCases(c: Context<AppEnv>): Promise<Response> {
  const { clinicId } = tenant(c);
  const query = c.get("validatedQuery") as IdentityCaseQuery;
  const where = { clinicId, status: query.status };
  const [items, totalCount] = await Promise.all([
    db.hieIdentityReconciliation.findMany({
      where,
      select: {
        id: true,
        patientId: true,
        conflictingPatientId: true,
        identifierType: true,
        reasonCode: true,
        status: true,
        resolutionNote: true,
        resolvedAt: true,
        createdAt: true,
        updatedAt: true,
        patient: { select: { firstName: true, lastName: true } },
        conflictingPatient: { select: { firstName: true, lastName: true } },
        resolvedBy: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page,
    }),
    db.hieIdentityReconciliation.count({ where }),
  ]);
  return jsonSuccess(c, {
    data: items,
    meta: {
      page: query.page,
      perPage: query.per_page,
      totalCount,
      pageCount: Math.ceil(totalCount / query.per_page),
    },
  });
}

export async function resolveIdentityCase(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, actorId } = tenant(c);
  const caseId = Number(c.req.param("caseId"));
  const input = c.get("validatedJson") as {
    status: "RESOLVED" | "DISMISSED";
    note: string;
  };
  const updated = await db.hieIdentityReconciliation.updateMany({
    where: { id: caseId, clinicId, status: "OPEN" },
    data: {
      status: input.status,
      resolutionNote: input.note,
      resolvedById: actorId,
      resolvedAt: new Date(),
    },
  });
  if (updated.count !== 1) {
    throw notFoundError("Open identity reconciliation case not found");
  }
  return jsonSuccess(c, { data: { id: caseId, status: input.status } });
}

export async function listHieAudit(c: Context<AppEnv>): Promise<Response> {
  const { clinicId } = tenant(c);
  const query = c.get("validatedQuery") as AuditQuery;
  const where = {
    clinicId,
    patientId: query.patientId,
    capability: query.capability,
  };
  const [items, totalCount] = await Promise.all([
    db.hieAuditEvent.findMany({
      where,
      select: {
        id: true,
        patientId: true,
        action: true,
        capability: true,
        purposeOfUse: true,
        outcome: true,
        correlationId: true,
        createdAt: true,
        actor: { select: { id: true, name: true, role: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page,
    }),
    db.hieAuditEvent.count({ where }),
  ]);
  return jsonSuccess(c, {
    data: items,
    meta: {
      page: query.page,
      perPage: query.per_page,
      totalCount,
      pageCount: Math.ceil(totalCount / query.per_page),
    },
  });
}

export async function listOutbox(c: Context<AppEnv>): Promise<Response> {
  const { clinicId, user } = tenant(c);
  if (user.role !== "CLINIC_ADMIN") {
    throw new AppError({
      status: 403,
      code: "HIE_OUTBOX_CLINIC_ADMIN_REQUIRED",
      message: "Only a clinic administrator can view HIE publication events",
      exposeMessage: true,
    });
  }
  const query = c.get("validatedQuery") as OutboxQuery;
  const where = { clinicId, status: query.status };
  const [events, totalCount] = await Promise.all([
    db.hieOutboxEvent.findMany({
      where: {
        ...where,
      },
      select: {
        id: true,
        aggregateType: true,
        aggregateId: true,
        resourceType: true,
        operation: true,
        status: true,
        dependencyReason: true,
        dependencyOrder: true,
        attemptCount: true,
        nextAttemptAt: true,
        correlationId: true,
        completedAt: true,
        lastErrorCode: true,
        lastErrorMessage: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page,
    }),
    db.hieOutboxEvent.count({ where }),
  ]);
  return jsonSuccess(c, {
    data: events,
    meta: {
      page: query.page,
      perPage: query.per_page,
      totalCount,
      pageCount: Math.ceil(totalCount / query.per_page),
    },
  });
}

export async function getOperationsSummary(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, user } = tenant(c);
  if (user.role !== "CLINIC_ADMIN") {
    throw new AppError({
      status: 403,
      code: "HIE_OPERATIONS_CLINIC_ADMIN_REQUIRED",
      message: "Only a clinic administrator can view HIE operations metrics",
      exposeMessage: true,
    });
  }
  const query = c.get("validatedQuery") as OperationsSummaryQuery;
  return jsonSuccess(c, {
    data: await getHieOperationsSummary({ clinicId, hours: query.hours }),
  });
}

export async function retryOutboxEvent(c: Context<AppEnv>): Promise<Response> {
  const { clinicId, actorId, user } = tenant(c);
  if (user.role !== "CLINIC_ADMIN") {
    throw new AppError({
      status: 403,
      code: "HIE_OUTBOX_CLINIC_ADMIN_REQUIRED",
      message: "Only a clinic administrator can retry HIE publication events",
      exposeMessage: true,
    });
  }
  const result = await retryHieEvent({
    clinicId,
    eventId: c.req.param("eventId"),
  });
  if (result.count !== 1) {
    throw notFoundError("Retryable HIE event not found");
  }
  await audit({
    clinicId,
    actorId,
    action: "outbox.retry.queued",
    capability: "OUTBOX",
    outcome: "QUEUED",
    correlationId: randomUUID(),
  });
  return jsonSuccess(c, { status: 202, data: { queued: true } });
}

export async function refreshInboundTransfers(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, actorId } = tenant(c);
  const config = await requireCapability(clinicId, "transferEnabled");
  const patientId = Number(c.req.param("patientId"));
  await scopedPatient(clinicId, patientId);
  await requireActiveConsent(clinicId, patientId);
  const identity = await db.patientExternalIdentity.findFirst({
    where: {
      patientId,
      verificationStatus: "VERIFIED",
      resourceIdEncrypted: { not: null },
    },
    orderBy: { verifiedAt: "desc" },
  });
  if (!identity?.resourceIdEncrypted) {
    throw new AppError({
      status: 409,
      code: "HIE_PATIENT_NOT_LINKED",
      message: "Link the patient before retrieving inbound transfers",
      exposeMessage: true,
    });
  }
  const response = await rhieRequest({
    service: "SHR",
    method: "GET",
    path: "Encounter/$list-transfers",
    tenantEnvironment: config.environment,
    query: { patient: decryptHieValue(identity.resourceIdEncrypted) },
  });
  const bundle = fhirBundleSchema.parse(response.data);
  let imported = 0;
  for (const entry of bundle.entry ?? []) {
    const parsed = fhirEncounterSummarySchema.safeParse(entry.resource);
    if (!parsed.success) {
      continue;
    }
    const encounter = parsed.data;
    const isTransfer = encounter.type?.some(
      (type) =>
        type.coding?.some((coding) => coding.code === "TRANSFER_ENCOUNTER") ||
        type.text === "TRANSFER_ENCOUNTER"
    );
    if (!isTransfer) {
      continue;
    }
    const origin = encounter.hospitalization?.origin;
    const clinicalDate = encounter.period?.start
      ? new Date(encounter.period.start)
      : null;
    await db.hieInboundTransfer.upsert({
      where: {
        clinicId_externalEncounterIdHash: {
          clinicId,
          externalEncounterIdHash: hashHieIdentifier(encounter.id),
        },
      },
      create: {
        clinicId,
        patientId,
        externalEncounterIdHash: hashHieIdentifier(encounter.id),
        externalEncounterIdEncrypted: encryptHieValue(encounter.id),
        sourceFacilityReference: origin?.reference,
        sourceFacilityDisplay: origin?.display,
        referringPractitionerDisplay:
          encounter.participant?.[0]?.individual?.display,
        reason: encounter.type?.[0]?.text,
        clinicalDate,
        payloadEncrypted: encryptHieJson(entry.resource),
      },
      update: {
        sourceFacilityReference: origin?.reference,
        sourceFacilityDisplay: origin?.display,
        referringPractitionerDisplay:
          encounter.participant?.[0]?.individual?.display,
        reason: encounter.type?.[0]?.text,
        clinicalDate,
        payloadEncrypted: encryptHieJson(entry.resource),
      },
    });
    imported += 1;
  }
  await audit({
    clinicId,
    actorId,
    patientId,
    action: "inbound-transfer.refreshed",
    capability: "TRANSFER",
    outcome: "SUCCESS",
    correlationId: response.correlationId,
    metadata: { imported },
  });
  return jsonSuccess(c, { data: { imported } });
}

export async function listInboundTransfers(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId } = tenant(c);
  const query = c.get("validatedQuery") as InboundTransferQuery;
  const where = {
    clinicId,
    patientId: query.patientId,
    status: query.status,
  };
  const [items, totalCount] = await Promise.all([
    db.hieInboundTransfer.findMany({
      where,
      select: {
        id: true,
        patientId: true,
        sourceFacilityReference: true,
        sourceFacilityDisplay: true,
        referringPractitionerDisplay: true,
        reason: true,
        clinicalDate: true,
        status: true,
        reviewedAt: true,
        acknowledgement: true,
        acknowledgedAt: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        patient: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page,
    }),
    db.hieInboundTransfer.count({ where }),
  ]);
  return jsonSuccess(c, {
    data: items,
    meta: {
      page: query.page,
      perPage: query.per_page,
      totalCount,
      pageCount: Math.ceil(totalCount / query.per_page),
    },
  });
}

export async function updateInboundTransfer(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, actorId } = tenant(c);
  const inboundTransferId = Number(c.req.param("inboundTransferId"));
  const input = c.get("validatedJson") as InboundTransferAction;
  const now = new Date();
  const updated = await db.hieInboundTransfer.updateMany({
    where: { id: inboundTransferId, clinicId },
    data: {
      status: input.status,
      reviewedById: actorId,
      reviewedAt: now,
      acknowledgement: input.note,
      acknowledgedAt: input.status === "ACKNOWLEDGED" ? now : undefined,
      completedAt: input.status === "COMPLETED" ? now : undefined,
    },
  });
  if (updated.count !== 1) {
    throw notFoundError("Inbound transfer not found");
  }
  return jsonSuccess(c, {
    data: { id: inboundTransferId, status: input.status },
  });
}

export async function createExternalTransfer(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, actorId, user } = tenant(c);
  await requireCapability(clinicId, "transferEnabled");
  if (user.role !== "DOCTOR") {
    throw new AppError({
      status: 403,
      code: "HIE_TRANSFER_CLINICAL_ROLE_REQUIRED",
      message: "A doctor must initiate the transfer",
      exposeMessage: true,
    });
  }
  const branchId = transferBranchScope(user);
  const input = c.get("validatedJson") as CreateTransferInput;
  const [visit, destination] = await Promise.all([
    db.visit.findFirst({
      where: {
        id: input.visitId,
        clinicId,
        ...(branchId ? { branchId } : {}),
      },
      select: { id: true, patientId: true, branchId: true, status: true },
    }),
    db.hieDestinationFacility.findFirst({
      where: {
        id: input.destinationFacilityId,
        clinicId,
        verificationStatus: "VERIFIED",
      },
    }),
  ]);
  if (!visit?.branchId) {
    throw new AppError({
      status: 409,
      code: "TRANSFER_SOURCE_BRANCH_REQUIRED",
      message: "The visit must belong to a branch before it can be transferred",
      exposeMessage: true,
    });
  }
  if (visit.status !== "FINALIZED") {
    throw new AppError({
      status: 409,
      code: "HIE_TRANSFER_FINALIZED_VISIT_REQUIRED",
      message: "Finalize the visit before creating a national transfer",
      exposeMessage: true,
    });
  }
  if (!destination) {
    throw new AppError({
      status: 409,
      code: "HIE_TRANSFER_DESTINATION_NOT_VERIFIED",
      message: "Select a verified national destination facility",
      exposeMessage: true,
    });
  }
  const sourceFacility = await db.hieFacilityLink.findFirst({
    where: {
      clinicId,
      branchId: visit.branchId,
      verificationStatus: "VERIFIED",
    },
    select: { fosaCode: true, locationReference: true },
  });
  if (!sourceFacility) {
    throw new AppError({
      status: 409,
      code: "HIE_TRANSFER_SOURCE_NOT_VERIFIED",
      message: "Verify the source branch HIE facility mapping first",
      exposeMessage: true,
    });
  }
  if (
    sourceFacility.fosaCode === destination.fosaCode ||
    sourceFacility.locationReference === destination.locationReference
  ) {
    throw new AppError({
      status: 409,
      code: "HIE_TRANSFER_DESTINATION_EQUALS_SOURCE",
      message: "The destination must be different from the source facility",
      exposeMessage: true,
    });
  }
  const transfer = await db.hieExternalTransfer.create({
    data: {
      clinicId,
      sourceBranchId: visit.branchId,
      visitId: visit.id,
      patientId: visit.patientId,
      referringPractitionerId: actorId,
      destinationFacilityId: destination.id,
      destinationFosaCode: destination.fosaCode,
      destinationLocationReference: destination.locationReference,
      reason: input.reason,
      urgency: input.urgency,
      clinicalSummary: input.clinicalSummary,
    },
  });
  await audit({
    clinicId,
    actorId,
    patientId: visit.patientId,
    action: "transfer.created",
    capability: "TRANSFER",
    outcome: "DRAFT",
    correlationId: randomUUID(),
    metadata: { transferId: transfer.id },
  });
  return jsonSuccess(c, { status: 201, data: transfer });
}

export async function listExternalTransfers(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, user } = tenant(c);
  const branchId = transferBranchScope(user);
  const query = c.get("validatedQuery") as TransferQuery;
  const where = {
    clinicId,
    status: query.status,
    patientId: query.patientId,
    ...(branchId ? { sourceBranchId: branchId } : {}),
  };
  const [transfers, totalCount] = await Promise.all([
    db.hieExternalTransfer.findMany({
      where,
      select: {
        id: true,
        visitId: true,
        patientId: true,
        destinationFosaCode: true,
        destinationLocationReference: true,
        urgency: true,
        status: true,
        sentAt: true,
        acknowledgedAt: true,
        cancelledAt: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        patient: { select: { id: true, firstName: true, lastName: true } },
        sourceBranch: { select: { id: true, name: true } },
        referringPractitioner: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page,
    }),
    db.hieExternalTransfer.count({ where }),
  ]);
  return jsonSuccess(c, {
    data: transfers,
    meta: {
      page: query.page,
      perPage: query.per_page,
      totalCount,
      pageCount: Math.ceil(totalCount / query.per_page),
    },
  });
}

export async function getExternalTransfer(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, user } = tenant(c);
  const branchId = transferBranchScope(user);
  const transferId = Number(c.req.param("transferId"));
  const transfer = await db.hieExternalTransfer.findFirst({
    where: {
      id: transferId,
      clinicId,
      ...(branchId ? { sourceBranchId: branchId } : {}),
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      sourceBranch: { select: { id: true, name: true } },
      referringPractitioner: { select: { id: true, name: true } },
    },
  });
  if (!transfer) {
    throw notFoundError("HIE transfer not found");
  }
  return jsonSuccess(c, { data: transfer });
}

export async function queueExternalTransfer(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, actorId, user } = tenant(c);
  const config = await requireCapability(clinicId, "transferEnabled");
  const branchId = transferBranchScope(user);
  const transferId = Number(c.req.param("transferId"));
  const queued = await db.$transaction(async (tx) => {
    const transfer = await tx.hieExternalTransfer.findFirst({
      where: {
        id: transferId,
        clinicId,
        ...(branchId ? { sourceBranchId: branchId } : {}),
        status: { in: ["DRAFT", "FAILED"] },
      },
      include: {
        visit: { select: { startTime: true, endTime: true } },
      },
    });
    if (!transfer) {
      throw notFoundError("Draft or failed transfer not found");
    }
    const claimed = await tx.hieExternalTransfer.updateMany({
      where: { id: transferId, clinicId, status: transfer.status },
      data: { status: "QUEUED" },
    });
    if (claimed.count !== 1) {
      throw notFoundError("Draft or failed transfer not found");
    }
    if (transfer.status === "FAILED") {
      const existing = await tx.hieOutboxEvent.findMany({
        where: {
          clinicId,
          aggregateType: "HieExternalTransfer",
          aggregateId: String(transferId),
          status: { in: ["BLOCKED", "DEAD_LETTER", "RETRY"] },
        },
        orderBy: [{ dependencyOrder: "asc" }, { createdAt: "asc" }],
        select: { id: true },
      });
      if (existing.length === 0) {
        throw new AppError({
          status: 409,
          code: "HIE_TRANSFER_RETRY_EVENT_NOT_FOUND",
          message: "The failed transfer has no retryable publication event",
          exposeMessage: true,
        });
      }
      await tx.hieOutboxEvent.updateMany({
        where: { id: { in: existing.map((event) => event.id) } },
        data: {
          status: "PENDING",
          dependencyReason: null,
          nextAttemptAt: new Date(),
          lockedAt: null,
        },
      });
      return {
        eventIds: existing.map((event) => event.id),
        patientId: transfer.patientId,
      };
    }
    const snapshot = {
      transferId,
      visitId: transfer.visitId,
      patientId: transfer.patientId,
      sourceBranchId: transfer.sourceBranchId,
      referringPractitionerId: transfer.referringPractitionerId,
      destinationFacilityId: transfer.destinationFacilityId,
      destinationLocationReference: transfer.destinationLocationReference,
      reason: transfer.reason,
      clinicalSummary: transfer.clinicalSummary,
      startedAt: transfer.visit.startTime.toISOString(),
      endedAt: transfer.visit.endTime?.toISOString() ?? null,
      authoredAt: new Date().toISOString(),
    };
    const created = await Promise.all(
      (
        [
          { resourceType: "TransferEncounter", dependencyOrder: 20 },
          { resourceType: "TransferIPS", dependencyOrder: 21 },
        ] as const
      ).map(({ resourceType, dependencyOrder }) =>
        tx.hieOutboxEvent.create({
          data: {
            clinicId,
            aggregateType: "HieExternalTransfer",
            aggregateId: String(transferId),
            resourceType,
            operation: "CREATE",
            dependencyOrder,
            payloadEncrypted: encryptHieJson(snapshot),
            idempotencyKey: hieOutboxIdempotencyKey({
              environment: config.environment,
              clinicId,
              localResourceType: "HieExternalTransfer",
              localResourceId: String(transferId),
              hieResourceType: resourceType,
              operation: "CREATE",
            }),
            correlationId: randomUUID(),
          },
          select: { id: true },
        })
      )
    );
    return {
      eventIds: created.map((event) => event.id),
      patientId: transfer.patientId,
    };
  });
  await audit({
    clinicId,
    actorId,
    patientId: queued.patientId,
    action: "transfer.queued",
    capability: "TRANSFER",
    outcome: "QUEUED",
    correlationId: randomUUID(),
    metadata: { transferId },
  });
  return jsonSuccess(c, {
    status: 202,
    data: {
      queued: true,
      eventId: queued.eventIds[0],
      eventIds: queued.eventIds,
    },
  });
}

export async function cancelExternalTransfer(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, actorId, user } = tenant(c);
  const branchId = transferBranchScope(user);
  const transferId = Number(c.req.param("transferId"));
  const input = c.get("validatedJson") as CancelTransferInput;
  const result = await db.$transaction(async (tx) => {
    const inFlight = await tx.hieOutboxEvent.findFirst({
      where: {
        clinicId,
        aggregateType: "HieExternalTransfer",
        aggregateId: String(transferId),
        status: "PROCESSING",
      },
      select: { id: true },
    });
    if (inFlight) {
      throw new AppError({
        status: 409,
        code: "HIE_TRANSFER_PUBLICATION_IN_PROGRESS",
        message:
          "The transfer is currently being published and cannot be cancelled",
        exposeMessage: true,
      });
    }
    const updated = await tx.hieExternalTransfer.updateMany({
      where: {
        id: transferId,
        clinicId,
        ...(branchId ? { sourceBranchId: branchId } : {}),
        status: { in: ["DRAFT", "QUEUED", "FAILED"] },
      },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        acknowledgement: input.reason,
      },
    });
    if (updated.count === 1) {
      await tx.hieOutboxEvent.updateMany({
        where: {
          clinicId,
          aggregateType: "HieExternalTransfer",
          aggregateId: String(transferId),
          status: { in: ["PENDING", "RETRY", "BLOCKED"] },
        },
        data: {
          status: "BLOCKED",
          dependencyReason: "Transfer cancelled before publication",
        },
      });
    }
    return updated;
  });
  if (result.count !== 1) {
    throw notFoundError("Cancellable transfer not found");
  }
  await audit({
    clinicId,
    actorId,
    action: "transfer.cancelled",
    capability: "TRANSFER",
    outcome: "CANCELLED",
    correlationId: randomUUID(),
    metadata: { transferId },
  });
  return jsonSuccess(c, { data: { cancelled: true } });
}
