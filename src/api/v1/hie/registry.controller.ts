import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { db } from "@/database/db";
import { jsonSuccess } from "@/lib/api-response";
import { AppError, isUniqueViolationOn, notFoundError } from "@/lib/app-error";
import type { AppEnv } from "@/middlewares/auth.middleware";
import {
  type FacilityDirectoryEntry,
  type FacilityVerificationOutcome,
  facilityRegistryAvailability,
  searchFacilityDirectory,
  syncFacilityDirectory,
  verifyFacilityIdentity,
} from "@/services/hie/facility-registry.service";
import {
  encryptHieValue,
  hashHieIdentifier,
} from "@/services/hie/hie-crypto.service";
import {
  providerRegistryMode,
  verifyPractitionerLicense,
} from "@/services/hie/provider-registry.service";
import type { HieEnvironment } from "../../../../generated/prisma/client";
import {
  audit,
  branchAdminScope,
  resumeReferenceBlockedEvents,
  tenant,
} from "./hie.shared";
import type {
  FacilityDirectoryQuery,
  VerifyDestinationInput,
  VerifyFacilityInput,
  VerifyPractitionerInput,
} from "./hie.validation";

const DEFAULT_VERIFICATION_TTL_DAYS = 90;
const MAX_VERIFICATION_TTL_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;
const FACILITY_SOURCE = "RHIE_FACILITY_REGISTRY";
const PROVIDER_SOURCE = "RHIE_PROVIDER_REGISTRY";

/**
 * Statuses a registry mismatch must not overwrite.
 *
 * CONFLICT blocks every outbox publish path, so a single Verify click on a
 * working mapping must not be able to halt national publication because the
 * snapshot is stale or our FOSA-system heuristic guessed wrong. Downgrading a
 * usable mapping stays an explicit admin action through PUT /facilities.
 */
const USABLE_STATUSES = new Set(["VERIFIED", "MANUAL_ATTESTED"]);

function verificationTtlDays(): number {
  const parsed = Number(process.env.HIE_REGISTRY_VERIFICATION_TTL_DAYS);
  if (
    !Number.isFinite(parsed) ||
    parsed <= 0 ||
    parsed > MAX_VERIFICATION_TTL_DAYS
  ) {
    return DEFAULT_VERIFICATION_TTL_DAYS;
  }
  return Math.floor(parsed);
}

/**
 * Registry facts drift — facilities close, merge and get renamed — so a
 * verification that never expires would be a false claim. The existing
 * expired-mapping metric surfaces these without new plumbing.
 */
function registryVerificationExpiry(now: Date): Date {
  return new Date(now.getTime() + verificationTtlDays() * DAY_MS);
}

/**
 * The tenant's HIE environment, which decides *which* directory snapshot may
 * justify a verification. A TEST snapshot must never verify a PRODUCTION
 * mapping.
 */
async function tenantEnvironment(clinicId: number): Promise<HieEnvironment> {
  const config = await db.hieTenantConfig.findUnique({
    where: { clinicId },
    select: { environment: true },
  });
  if (!config) {
    throw new AppError({
      status: 409,
      code: "HIE_NOT_CONFIGURED",
      message: "Configure the clinic's HIE environment before verifying",
      exposeMessage: true,
    });
  }
  return config.environment;
}

function conflictError(
  outcome: Extract<FacilityVerificationOutcome, { status: "CONFLICT" }>
): AppError {
  const codes = {
    FOSA_NOT_IN_REGISTRY: "HIE_FACILITY_REGISTRY_FOSA_NOT_FOUND",
    LOCATION_REFERENCE_MISMATCH: "HIE_FACILITY_REGISTRY_LOCATION_MISMATCH",
    LOCATION_REFERENCE_UNAVAILABLE:
      "HIE_FACILITY_REGISTRY_LOCATION_UNAVAILABLE",
    FACILITY_INACTIVE: "HIE_FACILITY_REGISTRY_FACILITY_INACTIVE",
  } as const;
  const messages = {
    FOSA_NOT_IN_REGISTRY:
      "This FOSA code is not in the national Facility Registry",
    LOCATION_REFERENCE_MISMATCH:
      "The national registry holds a different location reference for this FOSA code",
    LOCATION_REFERENCE_UNAVAILABLE:
      "The registry lists this facility but publishes no location reference for it",
    FACILITY_INACTIVE: "The national registry lists this facility as inactive",
  } as const;
  return new AppError({
    status: 409,
    code: codes[outcome.reason],
    message: messages[outcome.reason],
    exposeMessage: true,
    // The registry's own view travels in `issues` so the console can offer a
    // one-click correction rather than making the admin re-search by hand.
    issues: outcome.entry
      ? [
          {
            field: "locationReference",
            code: "REGISTRY_EXPECTED",
            message: outcome.entry.locationReference ?? "",
          },
          {
            field: "displayName",
            code: "REGISTRY_EXPECTED",
            message: outcome.entry.name,
          },
        ]
      : undefined,
  });
}

function unavailableError(
  reason: "REGISTRY_NOT_CONFIGURED" | "DIRECTORY_EMPTY"
): AppError {
  return new AppError({
    status: 503,
    code:
      reason === "REGISTRY_NOT_CONFIGURED"
        ? "HIE_FACILITY_REGISTRY_UNAVAILABLE"
        : "HIE_FACILITY_REGISTRY_DIRECTORY_EMPTY",
    message:
      reason === "REGISTRY_NOT_CONFIGURED"
        ? "The national Facility Registry is not configured for this deployment"
        : "The national facility directory has not been synchronised yet",
    exposeMessage: true,
  });
}

function serialiseEntry(entry: FacilityDirectoryEntry) {
  return {
    fosaCode: entry.fosaCode,
    name: entry.name,
    locationReference: entry.locationReference,
    organizationReference: entry.organizationReference,
    facilityType: entry.facilityType,
    province: entry.province,
    district: entry.district,
    registrySyncedAt: entry.registrySyncedAt,
  };
}

export async function searchRegistryFacilities(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId } = tenant(c);
  const query = c.get("validatedQuery") as FacilityDirectoryQuery;
  const environment = await tenantEnvironment(clinicId);
  const availability = await facilityRegistryAvailability(environment);
  // Never an error when unconfigured or empty: the console reads `mode` and
  // degrades to manual entry rather than showing the admin a failure.
  const items =
    availability.mode === "REGISTRY"
      ? await searchFacilityDirectory({
          environment,
          search: query.search,
          district: query.district,
          limit: query.limit,
        })
      : [];
  return jsonSuccess(c, {
    data: {
      mode: availability.mode,
      stale: availability.stale,
      lastSyncedAt: availability.lastSyncedAt,
      entryCount: availability.entryCount,
      items: items.map(serialiseEntry),
    },
  });
}

export async function syncRegistryFacilities(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, actorId } = tenant(c);
  const environment = await tenantEnvironment(clinicId);
  const correlationId = randomUUID();
  const result = await syncFacilityDirectory({ environment, correlationId });
  await audit({
    clinicId,
    actorId,
    action: "facility-registry.synced",
    capability: "FACILITY_REGISTRY",
    outcome: result.skipped ? (result.reason ?? "SKIPPED") : "SUCCESS",
    correlationId,
    metadata: {
      entryCount: result.entryCount,
      skippedCount: result.skippedCount,
      pageCount: result.pageCount,
    },
  });
  return jsonSuccess(c, { data: result });
}

/**
 * Records that a check happened without changing a usable status, then fails.
 */
async function rejectFacilityMismatch(params: {
  clinicId: number;
  actorId: number;
  outcome: Extract<FacilityVerificationOutcome, { status: "CONFLICT" }>;
  currentStatus: string;
  stamp: () => Promise<unknown>;
  action: string;
  metadata: Record<string, string | number | boolean>;
}): Promise<never> {
  await params.stamp();
  await audit({
    clinicId: params.clinicId,
    actorId: params.actorId,
    action: params.action,
    capability: "FACILITY_REGISTRY",
    outcome: `CONFLICT_${params.outcome.reason}`,
    correlationId: randomUUID(),
    metadata: {
      ...params.metadata,
      previousStatus: params.currentStatus,
      // Whether the mapping was left usable is the audit-relevant fact.
      downgraded: !USABLE_STATUSES.has(params.currentStatus),
    },
  });
  throw conflictError(params.outcome);
}

export async function verifyFacilityLink(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, actorId, user } = tenant(c);
  const branchId = branchAdminScope(user);
  const input = c.get("validatedJson") as VerifyFacilityInput;
  if (branchId && branchId !== input.branchId) {
    throw notFoundError("Branch not found");
  }
  const link = await db.hieFacilityLink.findFirst({
    where: { clinicId, branchId: input.branchId },
    select: {
      id: true,
      fosaCode: true,
      locationReference: true,
      verificationStatus: true,
    },
  });
  if (!link) {
    throw new AppError({
      status: 409,
      code: "HIE_FACILITY_MAPPING_REQUIRED",
      message: "Map the branch to a facility before verifying it",
      exposeMessage: true,
    });
  }

  const environment = await tenantEnvironment(clinicId);
  const outcome = await verifyFacilityIdentity({
    environment,
    fosaCode: link.fosaCode,
    locationReference: link.locationReference,
  });
  if (outcome.status === "UNAVAILABLE") {
    throw unavailableError(outcome.reason);
  }
  const now = new Date();
  if (outcome.status === "CONFLICT") {
    return await rejectFacilityMismatch({
      clinicId,
      actorId,
      outcome,
      currentStatus: link.verificationStatus,
      action: "facility.link.verify",
      metadata: { branchId: input.branchId },
      stamp: () =>
        db.hieFacilityLink.update({
          where: { id: link.id },
          data: {
            lastRegistryCheckAt: now,
            // Only a mapping that was not already usable is moved to CONFLICT.
            ...(USABLE_STATUSES.has(link.verificationStatus)
              ? {}
              : { verificationStatus: "CONFLICT" as const }),
          },
        }),
    });
  }

  const updated = await db.hieFacilityLink.update({
    where: { id: link.id },
    data: {
      // The registry is authoritative for both the reference and the name.
      locationReference: outcome.locationReference,
      displayName: outcome.entry.name,
      verificationStatus: "VERIFIED",
      verificationSource: FACILITY_SOURCE,
      verificationReference: `facility-registry:${link.fosaCode}@${outcome.entry.registrySyncedAt.toISOString()}`,
      verificationActorId: actorId,
      verifiedAt: now,
      lastRegistryCheckAt: now,
      verificationExpiresAt: registryVerificationExpiry(now),
    },
  });
  await resumeReferenceBlockedEvents(clinicId, [
    "FACILITY_IDENTITY_REQUIRED",
    "CLINICAL_REFERENCES_REQUIRED",
  ]);
  await audit({
    clinicId,
    actorId,
    action: "facility.link.verified",
    capability: "FACILITY_REGISTRY",
    outcome: "SUCCESS",
    correlationId: randomUUID(),
    metadata: { branchId: input.branchId, fosaCode: link.fosaCode },
  });
  return jsonSuccess(c, {
    data: { mapping: updated, registry: serialiseEntry(outcome.entry) },
  });
}

export async function verifyDestinationFacility(
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
  const input = c.get("validatedJson") as VerifyDestinationInput;
  const destination = await db.hieDestinationFacility.findFirst({
    where: { id: input.id, clinicId },
    select: {
      id: true,
      fosaCode: true,
      locationReference: true,
      verificationStatus: true,
    },
  });
  if (!destination) {
    throw notFoundError("HIE destination facility not found");
  }

  const environment = await tenantEnvironment(clinicId);
  const outcome = await verifyFacilityIdentity({
    environment,
    fosaCode: destination.fosaCode,
    locationReference: destination.locationReference,
  });
  if (outcome.status === "UNAVAILABLE") {
    throw unavailableError(outcome.reason);
  }
  const now = new Date();
  if (outcome.status === "CONFLICT") {
    return await rejectFacilityMismatch({
      clinicId,
      actorId,
      outcome,
      currentStatus: destination.verificationStatus,
      action: "destination-facility.verify",
      metadata: { destinationFacilityId: destination.id },
      stamp: () =>
        db.hieDestinationFacility.update({
          where: { id: destination.id },
          data: {
            lastRegistryCheckAt: now,
            ...(USABLE_STATUSES.has(destination.verificationStatus)
              ? {}
              : { verificationStatus: "CONFLICT" as const }),
          },
        }),
    });
  }

  try {
    const updated = await db.hieDestinationFacility.update({
      where: { id: destination.id },
      data: {
        locationReference: outcome.locationReference,
        displayName: outcome.entry.name,
        verificationStatus: "VERIFIED",
        verificationSource: FACILITY_SOURCE,
        verificationReference: `facility-registry:${destination.fosaCode}@${outcome.entry.registrySyncedAt.toISOString()}`,
        verificationActorId: actorId,
        verifiedAt: now,
        lastRegistryCheckAt: now,
        verificationExpiresAt: registryVerificationExpiry(now),
      },
    });
    // Attesting or verifying a destination previously left already-blocked
    // transfer events waiting for their next natural retry.
    await resumeReferenceBlockedEvents(clinicId, [
      "DESTINATION_FACILITY_REQUIRED",
    ]);
    await audit({
      clinicId,
      actorId,
      action: "destination-facility.verified",
      capability: "FACILITY_REGISTRY",
      outcome: "SUCCESS",
      correlationId: randomUUID(),
      metadata: { destinationFacilityId: destination.id },
    });
    return jsonSuccess(c, {
      data: { destination: updated, registry: serialiseEntry(outcome.entry) },
    });
  } catch (error) {
    if (isUniqueViolationOn(error, ["clinicId", "locationReference"])) {
      throw new AppError({
        status: 409,
        code: "HIE_DESTINATION_ALREADY_EXISTS",
        message:
          "Another destination for this clinic already uses the registry's location reference",
        exposeMessage: true,
      });
    }
    throw error;
  }
}

export async function verifyPractitionerLink(
  c: Context<AppEnv>
): Promise<Response> {
  const { clinicId, actorId, user: actor } = tenant(c);
  const branchId = branchAdminScope(actor);
  const input = c.get("validatedJson") as VerifyPractitionerInput;
  if (providerRegistryMode() === "MANUAL_ONLY") {
    throw new AppError({
      status: 503,
      code: "HIE_PROVIDER_REGISTRY_NOT_CONFIGURED",
      message:
        "The national Provider Registry is not configured for this deployment",
      exposeMessage: true,
    });
  }
  const user = await db.user.findFirst({
    where: { id: input.userId, clinicId, ...(branchId ? { branchId } : {}) },
    select: { id: true, licenseNumber: true },
  });
  if (!user) {
    throw notFoundError("User not found");
  }
  if (!user.licenseNumber) {
    throw new AppError({
      status: 409,
      code: "HIE_PRACTITIONER_LICENSE_REQUIRED",
      message:
        "Add this clinician's licence number before verifying them against the registry",
      exposeMessage: true,
    });
  }

  const environment = await tenantEnvironment(clinicId);
  const outcome = await verifyPractitionerLicense({
    licenseNumber: user.licenseNumber,
    environment,
  });
  if (outcome.status === "UNAVAILABLE") {
    throw new AppError({
      status: 503,
      code: "HIE_PROVIDER_REGISTRY_NOT_CONFIGURED",
      message:
        "The national Provider Registry is not configured for this deployment",
      exposeMessage: true,
    });
  }
  const now = new Date();
  if (outcome.status === "CONFLICT") {
    await db.userExternalIdentity.updateMany({
      where: { userId: user.id, identifierType: "PRACTITIONER" },
      data: { lastRegistryCheckAt: now },
    });
    await audit({
      clinicId,
      actorId,
      action: "practitioner.link.verify",
      capability: "PRACTITIONER_REGISTRY",
      outcome: `CONFLICT_${outcome.reason}`,
      correlationId: outcome.correlationId,
      metadata: { userId: user.id },
    });
    throw new AppError({
      status: 409,
      code:
        outcome.reason === "LICENSE_INACTIVE"
          ? "HIE_PRACTITIONER_REGISTRY_LICENSE_INACTIVE"
          : "HIE_PRACTITIONER_REGISTRY_LICENSE_NOT_FOUND",
      message:
        outcome.reason === "LICENSE_INACTIVE"
          ? `The national registry reports this licence as ${outcome.licenseStatus}`
          : "This licence number is not in the national Provider Registry",
      exposeMessage: true,
    });
  }

  const identifierHash = hashHieIdentifier(outcome.practitionerId);
  const conflicting = await db.userExternalIdentity.findUnique({
    where: {
      identifierType_identifierHash: {
        identifierType: "PRACTITIONER",
        identifierHash,
      },
    },
    select: { userId: true },
  });
  if (conflicting && conflicting.userId !== user.id) {
    throw new AppError({
      status: 409,
      code: "HIE_PRACTITIONER_ALREADY_LINKED",
      message: "This national practitioner is already linked to another user",
      exposeMessage: true,
    });
  }

  const identity = await db.$transaction(async (tx) => {
    const upserted = await tx.userExternalIdentity.upsert({
      where: {
        identifierType_identifierHash: {
          identifierType: "PRACTITIONER",
          identifierHash,
        },
      },
      create: {
        userId: user.id,
        identifierType: "PRACTITIONER",
        identifierHash,
        identifierEncrypted: encryptHieValue(outcome.practitionerId),
        verificationStatus: "VERIFIED",
        verificationSource: PROVIDER_SOURCE,
        verificationReference: `provider-registry:${outcome.licenseStatus}`,
        verificationActorId: actorId,
        verifiedAt: now,
        lastRegistryCheckAt: now,
        verificationExpiresAt: registryVerificationExpiry(now),
      },
      update: {
        userId: user.id,
        identifierEncrypted: encryptHieValue(outcome.practitionerId),
        verificationStatus: "VERIFIED",
        verificationSource: PROVIDER_SOURCE,
        verificationReference: `provider-registry:${outcome.licenseStatus}`,
        verificationActorId: actorId,
        verifiedAt: now,
        lastRegistryCheckAt: now,
        verificationExpiresAt: registryVerificationExpiry(now),
      },
      select: {
        id: true,
        userId: true,
        verificationStatus: true,
        verifiedAt: true,
        lastRegistryCheckAt: true,
        verificationExpiresAt: true,
      },
    });
    // The registry may resolve a different practitioner id than an admin once
    // typed by hand. Without this, the upsert leaves a second PRACTITIONER row
    // for the user and getMappings would surface whichever came first.
    await tx.userExternalIdentity.deleteMany({
      where: {
        userId: user.id,
        identifierType: "PRACTITIONER",
        NOT: { id: upserted.id },
      },
    });
    return upserted;
  });

  await resumeReferenceBlockedEvents(clinicId, [
    "PRACTITIONER_IDENTITY_REQUIRED",
    "CLINICAL_REFERENCES_REQUIRED",
  ]);
  await audit({
    clinicId,
    actorId,
    action: "practitioner.link.verified",
    capability: "PRACTITIONER_REGISTRY",
    outcome: "SUCCESS",
    correlationId: outcome.correlationId,
    metadata: { userId: user.id },
  });
  return jsonSuccess(c, {
    data: {
      mapping: {
        ...identity,
        practitionerReference: outcome.practitionerReference,
      },
      registry: { licenseStatus: outcome.licenseStatus },
    },
  });
}
