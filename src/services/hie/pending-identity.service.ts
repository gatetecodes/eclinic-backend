import { z } from "zod";
import { db } from "@/database/db";
import { logger } from "@/lib/logger";
import { lookupNationalPatient } from "./client-registry.service";
import {
  decryptHieJson,
  decryptHieValue,
  encryptHieJson,
  encryptHieValue,
  hashHieIdentifier,
} from "./hie-crypto.service";
import { resumeBlockedPatientEvents } from "./outbox.service";

const snapshotSchema = z.object({ birthDate: z.iso.date() });

const retryDelay = (attempt: number) => {
  const hours = [1, 6, 24, 24, 24, 24, 24, 24];
  return (hours[Math.min(attempt, hours.length - 1)] ?? 24) * 60 * 60_000;
};

function findPendingIdentities(limit: number) {
  return db.patientExternalIdentity.findMany({
    where: {
      identifierType: "NID",
      verificationStatus: "PENDING",
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
      patient: {
        clinics: {
          some: {
            hieTenantConfig: { enabled: true, clientRegistryEnabled: true },
          },
        },
      },
    },
    include: {
      patient: {
        select: {
          clinics: {
            where: {
              hieTenantConfig: { enabled: true, clientRegistryEnabled: true },
            },
            select: {
              id: true,
              hieTenantConfig: { select: { environment: true } },
            },
          },
        },
      },
    },
    orderBy: [{ nextRetryAt: "asc" }, { createdAt: "asc" }],
    take: limit,
  });
}

type PendingIdentity = Awaited<
  ReturnType<typeof findPendingIdentities>
>[number];
type RegistryMatch = Awaited<
  ReturnType<typeof lookupNationalPatient>
>["matches"][number];

function nextRetryAt(attempt: number) {
  return attempt >= 8 ? null : new Date(Date.now() + retryDelay(attempt));
}

async function markRetryFailure(identity: PendingIdentity, errorCode: string) {
  const attempt = identity.retryCount + 1;
  await db.patientExternalIdentity.update({
    where: { id: identity.id },
    data: {
      retryCount: attempt,
      lastAttemptAt: new Date(),
      lastErrorCode: errorCode,
      nextRetryAt: nextRetryAt(attempt),
    },
  });
  return attempt;
}

async function recordUpidConflict(
  identity: PendingIdentity,
  upid: string,
  conflictingPatientId: number
) {
  const upidHash = hashHieIdentifier(upid);
  await db.$transaction(async (tx) => {
    await tx.patientExternalIdentity.update({
      where: { id: identity.id },
      data: {
        verificationStatus: "CONFLICT",
        nextRetryAt: null,
        lastAttemptAt: new Date(),
        lastErrorCode: "UPID_ALREADY_LINKED",
      },
    });
    for (const clinic of identity.patient.clinics) {
      await tx.hieIdentityReconciliation.create({
        data: {
          clinicId: clinic.id,
          patientId: identity.patientId,
          conflictingPatientId,
          identifierType: "UPID",
          identifierHash: upidHash,
          identifierEncrypted: encryptHieValue(upid),
          reasonCode: "UPID_ALREADY_LINKED",
        },
      });
    }
  });
}

async function findConflictingUpid(
  identity: PendingIdentity,
  match: RegistryMatch
) {
  if (!match.upid) {
    return null;
  }
  const conflicting = await db.patientExternalIdentity.findUnique({
    where: {
      identifierType_identifierHash: {
        identifierType: "UPID",
        identifierHash: hashHieIdentifier(match.upid),
      },
    },
    select: { patientId: true },
  });
  return conflicting?.patientId !== identity.patientId ? conflicting : null;
}

async function markIdentityVerified(
  identity: PendingIdentity,
  match: RegistryMatch
) {
  await db.$transaction(async (tx) => {
    const resourceIdHash = hashHieIdentifier(match.externalPatientId);
    const resourceIdEncrypted = encryptHieValue(match.externalPatientId);
    await tx.patientExternalIdentity.update({
      where: { id: identity.id },
      data: {
        resourceIdHash,
        resourceIdEncrypted,
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
      const identifierHash = hashHieIdentifier(match.upid);
      await tx.patientExternalIdentity.upsert({
        where: {
          identifierType_identifierHash: {
            identifierType: "UPID",
            identifierHash,
          },
        },
        create: {
          patientId: identity.patientId,
          identifierType: "UPID",
          identifierHash,
          identifierEncrypted: encryptHieValue(match.upid),
          resourceIdHash,
          resourceIdEncrypted,
          verificationStatus: "VERIFIED",
          verifiedAt: new Date(),
          demographicsSnapshotEncrypted: encryptHieJson({
            nationalPatient: match,
          }),
        },
        update: {
          verificationStatus: "VERIFIED",
          verifiedAt: new Date(),
          resourceIdHash,
          resourceIdEncrypted,
        },
      });
    }
    for (const clinic of identity.patient.clinics) {
      await resumeBlockedPatientEvents(tx, {
        clinicId: clinic.id,
        patientId: identity.patientId,
      });
    }
  });
}

async function retryPendingIdentity(identity: PendingIdentity) {
  const tenantEnvironment =
    identity.patient.clinics[0]?.hieTenantConfig?.environment;
  if (!tenantEnvironment) {
    await markRetryFailure(identity, "HIE_TENANT_CONFIG_REQUIRED");
    return false;
  }
  const snapshot = snapshotSchema.safeParse(
    identity.demographicsSnapshotEncrypted
      ? decryptHieJson(identity.demographicsSnapshotEncrypted)
      : null
  );
  if (!snapshot.success) {
    await db.patientExternalIdentity.update({
      where: { id: identity.id },
      data: {
        lastAttemptAt: new Date(),
        lastErrorCode: "HIE_IDENTITY_SNAPSHOT_INVALID",
        nextRetryAt: null,
      },
    });
    return false;
  }
  const result = await lookupNationalPatient({
    nid: decryptHieValue(identity.identifierEncrypted),
    birthDate: snapshot.data.birthDate,
    tenantEnvironment,
  });
  const match = result.matches[0];
  if (!match) {
    await markRetryFailure(identity, "HIE_PATIENT_NOT_FOUND");
    return false;
  }
  const conflict = await findConflictingUpid(identity, match);
  if (conflict && match.upid) {
    await recordUpidConflict(identity, match.upid, conflict.patientId);
    return false;
  }
  await markIdentityVerified(identity, match);
  return true;
}

export async function processPendingIdentityVerifications(limit = 10) {
  const candidates = await findPendingIdentities(limit);
  let verified = 0;
  for (const identity of candidates) {
    try {
      verified += (await retryPendingIdentity(identity)) ? 1 : 0;
    } catch (error) {
      const attempt = await markRetryFailure(
        identity,
        "HIE_IDENTITY_RETRY_FAILED"
      );
      logger.warn("hie.identity.retry_failed", {
        attempt,
        error,
      });
    }
  }
  return { processed: candidates.length, verified };
}
