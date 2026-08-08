import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { z } from "zod";
import { db } from "@/database/db";
import { jsonSuccess } from "@/lib/api-response";
import { AppError, notFoundError } from "@/lib/app-error";
import type { AppEnv } from "@/middlewares/auth.middleware";
import { lookupNationalPatient } from "@/services/hie/client-registry.service";
import {
  capabilityStatementSchema,
  fhirBundleSchema,
} from "@/services/hie/fhir.schemas";
import {
  assertHieEncryptionConfigured,
  decryptHieJson,
  decryptHieValue,
  encryptHieJson,
  encryptHieValue,
  hashHieIdentifier,
} from "@/services/hie/hie-crypto.service";
import {
  birthDateStorageWindow,
  prioritizeLinkedCandidates,
} from "@/services/hie/local-patient-matching";
import { retryHieEvent } from "@/services/hie/outbox.service";
import { RhieRequestError, rhieRequest } from "@/services/hie/rhie-client";
import { getInternationalPatientSummaryView } from "@/services/hie/shared-record.service";
import type { Prisma } from "../../../../generated/prisma/client";
import type {
  cancelTransferSchema,
  consentSchema,
  createTransferSchema,
  deferVerificationSchema,
  linkPatientSchema,
  lookupPatientSchema,
  outboxQuerySchema,
  reconciliationSchema,
  transferQuerySchema,
  updateConfigSchema,
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
type ConsentInput = z.infer<typeof consentSchema>;
type WithdrawConsentInput = z.infer<typeof withdrawConsentSchema>;
type ReconciliationInput = z.infer<typeof reconciliationSchema>;
type CreateTransferInput = z.infer<typeof createTransferSchema>;
type CancelTransferInput = z.infer<typeof cancelTransferSchema>;
type OutboxQuery = z.infer<typeof outboxQuerySchema>;
type TransferQuery = z.infer<typeof transferQuerySchema>;

const reconciliationTokenSchema = z.object({
  patientId: z.number().int().positive(),
  resourceType: z.string().trim().min(1).max(100),
  resourceId: z.string().trim().min(1).max(200),
  expiresAt: z.iso.datetime(),
});

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
  };
}

function assertHieActivationReady(config: EffectiveHieConfig) {
  if (!config.enabled) {
    return;
  }
  assertHieEncryptionConfigured();
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
  const clientUrl = process.env.HIE_CLIENT_REGISTRY_BASE_URL;
  const shrUrl = process.env.HIE_SHR_BASE_URL;
  const shrEnabled =
    config.sharedRecordReadEnabled ||
    config.sharedRecordWriteEnabled ||
    config.transferEnabled;
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
  if (
    (config.clientRegistryEnabled && !clientUrl?.startsWith("https://")) ||
    (shrEnabled && !shrUrl?.startsWith("https://"))
  ) {
    throw new AppError({
      status: 409,
      code: "HIE_PRODUCTION_SECURE_TRANSPORT_REQUIRED",
      message: "Production HIE capabilities require HTTPS endpoints",
      exposeMessage: true,
    });
  }
}

async function refreshHieHealth(config: {
  clinicId: number;
  environment: "TEST" | "PRODUCTION";
  enabled: boolean;
  clientRegistryEnabled: boolean;
  sharedRecordReadEnabled: boolean;
  sharedRecordWriteEnabled: boolean;
  transferEnabled: boolean;
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
    probes.push(probeClientRegistry());
  }
  if (
    config.sharedRecordReadEnabled ||
    config.sharedRecordWriteEnabled ||
    config.transferEnabled
  ) {
    probes.push(
      rhieRequest({ service: "SHR", method: "GET", path: "metadata" }).then(
        (response) => capabilityStatementSchema.parse(response.data)
      )
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

async function probeClientRegistry(): Promise<void> {
  try {
    const response = await rhieRequest({
      service: "CLIENT_REGISTRY",
      method: "GET",
      path: "metadata",
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

async function requireCapability(
  clinicId: number,
  capability:
    | "clientRegistryEnabled"
    | "sharedRecordReadEnabled"
    | "sharedRecordWriteEnabled"
    | "transferEnabled"
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
  await db.hieReconciliation.upsert({
    where: {
      clinicId_patientId_externalResourceType_externalResourceIdHash: {
        clinicId: params.clinicId,
        patientId: params.patientId,
        externalResourceType: "PatientIdentity",
        externalResourceIdHash: params.identifierHash,
      },
    },
    create: {
      clinicId: params.clinicId,
      patientId: params.patientId,
      externalResourceType: "PatientIdentity",
      externalResourceIdHash: params.identifierHash,
      externalResourceIdEncrypted: encryptHieValue(params.identifier),
      status: "PENDING",
      notes: "National identifier is already linked to another local patient",
    },
    update: {
      status: "PENDING",
      reviewedById: null,
      reviewedAt: null,
      notes: "National identifier is already linked to another local patient",
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

export async function getStatus(c: Context<AppEnv>) {
  const { clinicId } = tenant(c);
  const configWithClinic = await db.hieTenantConfig.findUnique({
    where: { clinicId },
    include: { clinic: { select: { branches: { select: { id: true } } } } },
  });
  const config = configWithClinic
    ? await refreshHieHealth(configWithClinic)
    : null;
  const facilities = await db.hieFacilityLink.count({
    where: { clinicId, verificationStatus: "VERIFIED" },
  });
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
          }
        : null,
      verifiedFacilities: facilities,
      totalBranches: configWithClinic?.clinic.branches.length ?? 0,
      lastHealthStatus: config?.lastHealthStatus ?? null,
      lastHealthCheckedAt: config?.lastHealthCheckedAt ?? null,
    },
  });
}

export async function updateConfig(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const input = c.get("validatedJson") as ConfigInput;
  const existing = await db.hieTenantConfig.findUnique({ where: { clinicId } });
  const effective = effectiveHieConfig(input, existing);
  assertHieActivationReady(effective);
  const config = await db.hieTenantConfig.upsert({
    where: { clinicId },
    create: { clinicId, ...input },
    update: input,
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

export async function upsertFacilityLink(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const input = c.get("validatedJson") as FacilityInput;
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
      verifiedAt:
        input.verificationStatus === "VERIFIED" ? new Date() : undefined,
    },
    update: {
      fosaCode: input.fosaCode,
      locationReference: input.locationReference,
      displayName: input.displayName,
      verificationStatus: input.verificationStatus,
      verifiedAt: input.verificationStatus === "VERIFIED" ? new Date() : null,
    },
  });
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

export async function upsertPractitionerLink(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const input = c.get("validatedJson") as PractitionerInput;
  const user = await db.user.findFirst({
    where: { id: input.userId, clinicId },
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
      verifiedAt:
        input.verificationStatus === "VERIFIED" ? new Date() : undefined,
    },
    update: {
      userId: input.userId,
      identifierEncrypted: encryptHieValue(practitionerId),
      verificationStatus: input.verificationStatus,
      verifiedAt: input.verificationStatus === "VERIFIED" ? new Date() : null,
    },
    select: {
      id: true,
      userId: true,
      identifierType: true,
      verificationStatus: true,
      verifiedAt: true,
    },
  });
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

export async function lookupPatient(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  await requireCapability(clinicId, "clientRegistryEnabled");
  const input = c.get("validatedJson") as LookupInput;
  const result = await lookupNationalPatient(input);
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

export async function linkPatient(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  await requireCapability(clinicId, "clientRegistryEnabled");
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
  const conflictingLink = await db.patientExternalIdentity.findFirst({
    where: {
      identifierType: "NID",
      identifierHash,
      patientId: { not: input.patientId },
    },
    select: { patientId: true },
  });
  if (conflictingLink) {
    await recordIdentityConflict({
      clinicId,
      patientId: input.patientId,
      actorId,
      identifierHash,
      identifier: input.nid,
    });
    throw new AppError({
      status: 409,
      code: "HIE_IDENTITY_ALREADY_LINKED",
      message: "This national identity is already linked to another patient",
      exposeMessage: true,
    });
  }
  const snapshot = {
    nationalPatient,
    reviewedFields: input.reviewedFields,
    linkedAgainstPatientUpdatedAt: input.expectedPatientUpdatedAt,
  };
  const resourceHash = hashHieIdentifier(input.externalPatientId);
  const identity = await db.$transaction(async (tx) => {
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
        patientId: input.patientId,
        resourceIdHash: resourceHash,
        resourceIdEncrypted: encryptHieValue(input.externalPatientId),
        verificationStatus: "VERIFIED",
        verifiedAt: new Date(),
        deferredReason: null,
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
    if (nationalPatient.structuredAddress) {
      await tx.patient.update({
        where: { id: input.patientId },
        data: { structuredAddress: nationalPatient.structuredAddress },
      });
    }
    return linkedIdentity;
  });
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

export async function deferVerification(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  await requireCapability(clinicId, "clientRegistryEnabled");
  const input = c.get("validatedJson") as DeferInput;
  await scopedPatient(clinicId, input.patientId);
  const identifierHash = hashHieIdentifier(input.nid);
  const conflictingLink = await db.patientExternalIdentity.findFirst({
    where: {
      identifierType: "NID",
      identifierHash,
      patientId: { not: input.patientId },
    },
    select: { patientId: true },
  });
  if (conflictingLink) {
    await recordIdentityConflict({
      clinicId,
      patientId: input.patientId,
      actorId,
      identifierHash,
      identifier: input.nid,
    });
    throw new AppError({
      status: 409,
      code: "HIE_IDENTITY_ALREADY_LINKED",
      message: "This national identity is already linked to another patient",
      exposeMessage: true,
    });
  }
  const identity = await db.patientExternalIdentity.upsert({
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
      verificationStatus: "PENDING",
      deferredReason: input.note
        ? `${input.reason}: ${input.note}`
        : input.reason,
      demographicsSnapshotEncrypted: encryptHieJson({
        birthDate: input.birthDate,
      }),
    },
    update: {
      patientId: input.patientId,
      verificationStatus: "PENDING",
      deferredReason: input.note
        ? `${input.reason}: ${input.note}`
        : input.reason,
    },
    select: {
      id: true,
      patientId: true,
      identifierType: true,
      verificationStatus: true,
    },
  });
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

export async function getPatientIps(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  await requireCapability(clinicId, "sharedRecordReadEnabled");
  const patientId = Number(c.req.param("patientId"));
  await scopedPatient(clinicId, patientId);
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
    patientId
  );
  await audit({
    clinicId,
    actorId,
    patientId,
    action: "patient.ips.read",
    capability: "SHARED_RECORD",
    outcome: "SUCCESS",
    correlationId: summary.correlationId,
    metadata: { resourceCount: summary.items.length },
  });
  return jsonSuccess(c, { data: summary });
}

export async function createConsent(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const input = c.get("validatedJson") as ConsentInput;
  await scopedPatient(clinicId, input.patientId);
  const consent = await db.hieConsent.create({
    data: {
      clinicId,
      patientId: input.patientId,
      status: "ACTIVE",
      scope: input.scope,
      purpose: input.purpose,
      evidence: input.evidence as Prisma.InputJsonValue | undefined,
      effectiveFrom: new Date(input.effectiveFrom),
      effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : undefined,
      recordedById: actorId,
    },
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

export async function withdrawConsent(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const consentId = Number(c.req.param("consentId"));
  const input = c.get("validatedJson") as WithdrawConsentInput;
  const existing = await db.hieConsent.findFirst({
    where: { id: consentId, clinicId },
  });
  if (!existing) {
    throw notFoundError("Consent not found");
  }
  const consent = await db.hieConsent.update({
    where: { id: consentId },
    data: {
      status: "INACTIVE",
      withdrawnAt: new Date(),
      withdrawnReason: input.reason,
    },
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

export async function reconcileExternalResource(c: Context<AppEnv>) {
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

export async function listOutbox(c: Context<AppEnv>) {
  const { clinicId } = tenant(c);
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

export async function retryOutboxEvent(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
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

export async function createExternalTransfer(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  await requireCapability(clinicId, "transferEnabled");
  const input = c.get("validatedJson") as CreateTransferInput;
  const visit = await db.visit.findFirst({
    where: { id: input.visitId, clinicId },
    select: { id: true, patientId: true, branchId: true },
  });
  if (!visit?.branchId) {
    throw new AppError({
      status: 409,
      code: "TRANSFER_SOURCE_BRANCH_REQUIRED",
      message: "The visit must belong to a branch before it can be transferred",
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
      destinationFosaCode: input.destinationFosaCode,
      destinationLocationReference: input.destinationLocationReference,
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

export async function listExternalTransfers(c: Context<AppEnv>) {
  const { clinicId } = tenant(c);
  const query = c.get("validatedQuery") as TransferQuery;
  const where = { clinicId, status: query.status };
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

export async function getExternalTransfer(c: Context<AppEnv>) {
  const { clinicId } = tenant(c);
  const transferId = Number(c.req.param("transferId"));
  const transfer = await db.hieExternalTransfer.findFirst({
    where: { id: transferId, clinicId },
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

export async function queueExternalTransfer(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  await requireCapability(clinicId, "transferEnabled");
  const transferId = Number(c.req.param("transferId"));
  const transfer = await db.hieExternalTransfer.findFirst({
    where: { id: transferId, clinicId, status: { in: ["DRAFT", "FAILED"] } },
  });
  if (!transfer) {
    throw notFoundError("Draft or failed transfer not found");
  }
  const eventId = await db.$transaction(async (tx) => {
    await tx.hieExternalTransfer.update({
      where: { id: transferId },
      data: { status: "QUEUED" },
    });
    if (transfer.status === "FAILED") {
      const existing = await tx.hieOutboxEvent.findFirst({
        where: {
          clinicId,
          aggregateType: "HieExternalTransfer",
          aggregateId: String(transferId),
          status: { in: ["BLOCKED", "DEAD_LETTER", "RETRY"] },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (!existing) {
        throw new AppError({
          status: 409,
          code: "HIE_TRANSFER_RETRY_EVENT_NOT_FOUND",
          message: "The failed transfer has no retryable publication event",
          exposeMessage: true,
        });
      }
      await tx.hieOutboxEvent.update({
        where: { id: existing.id },
        data: {
          status: "PENDING",
          dependencyReason: null,
          nextAttemptAt: new Date(),
          lockedAt: null,
        },
      });
      return existing.id;
    }
    const created = await tx.hieOutboxEvent.create({
      data: {
        clinicId,
        aggregateType: "HieExternalTransfer",
        aggregateId: String(transferId),
        resourceType: "TransferEncounter",
        operation: "CREATE",
        dependencyOrder: 20,
        payloadEncrypted: encryptHieJson({ transferId }),
        correlationId: randomUUID(),
      },
      select: { id: true },
    });
    return created.id;
  });
  await audit({
    clinicId,
    actorId,
    patientId: transfer.patientId,
    action: "transfer.queued",
    capability: "TRANSFER",
    outcome: "QUEUED",
    correlationId: randomUUID(),
    metadata: { transferId },
  });
  return jsonSuccess(c, { status: 202, data: { queued: true, eventId } });
}

export async function cancelExternalTransfer(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
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
