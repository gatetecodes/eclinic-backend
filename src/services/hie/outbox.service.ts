import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "@/database/db";
import { logger } from "@/lib/logger";
import type { Prisma } from "../../../generated/prisma/client";
import { mapVisitCondition } from "./condition.mapper";
import {
  mapTransferEncounter,
  mapTransferIpsBundle,
  mapVisitEncounter,
} from "./encounter.mapper";
import {
  decryptHieJson,
  decryptHieValue,
  encryptHieJson,
  encryptHieValue,
  hashHieIdentifier,
} from "./hie-crypto.service";
import { RhieRequestError, rhieRequest } from "./rhie-client";

const MAX_ATTEMPTS = 8;
const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
  24 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

const visitPayloadSchema = z.object({ visitId: z.number().int().positive() });
const conditionPayloadSchema = z.object({
  diagnosisId: z.number().int().positive(),
});
const transferPayloadSchema = z.object({
  transferId: z.number().int().positive(),
});

export class HieDependencyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HieDependencyError";
    this.code = code;
  }
}

export async function enqueueFinalizedVisit(
  tx: Prisma.TransactionClient,
  params: { clinicId: number; visitId: number; patientId: number }
) {
  const config = await tx.hieTenantConfig.findUnique({
    where: { clinicId: params.clinicId },
    select: { enabled: true, sharedRecordWriteEnabled: true },
  });
  if (!(config?.enabled && config.sharedRecordWriteEnabled)) {
    return null;
  }
  const now = new Date();
  const [identity, consent] = await Promise.all([
    tx.patientExternalIdentity.findFirst({
      where: {
        patientId: params.patientId,
        verificationStatus: "VERIFIED",
        resourceIdEncrypted: { not: null },
      },
      select: { id: true },
    }),
    tx.hieConsent.findFirst({
      where: {
        clinicId: params.clinicId,
        patientId: params.patientId,
        status: "ACTIVE",
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      select: { id: true },
    }),
  ]);
  let dependencyReason: string | null = null;
  if (!identity) {
    dependencyReason = "Verified Client Registry identity is required";
  } else if (!consent) {
    dependencyReason = "Active HIE sharing consent is required";
  }
  const encounterEvent = await tx.hieOutboxEvent.create({
    data: {
      clinicId: params.clinicId,
      aggregateType: "Visit",
      aggregateId: String(params.visitId),
      resourceType: "Encounter",
      operation: "CREATE",
      payloadEncrypted: encryptHieJson({ visitId: params.visitId }),
      status: dependencyReason ? "BLOCKED" : "PENDING",
      dependencyReason,
      correlationId: randomUUID(),
    },
  });
  const diagnoses = await tx.visitDiagnosis.findMany({
    where: { visitId: params.visitId },
    select: { id: true, icd11Code: true },
  });
  for (const diagnosis of diagnoses) {
    const terminologyReason = diagnosis.icd11Code
      ? dependencyReason
      : "ICD-11 code is required for Condition publication";
    await tx.hieOutboxEvent.create({
      data: {
        clinicId: params.clinicId,
        aggregateType: "VisitDiagnosis",
        aggregateId: String(diagnosis.id),
        resourceType: "Condition",
        operation: "CREATE",
        dependencyOrder: 10,
        payloadEncrypted: encryptHieJson({ diagnosisId: diagnosis.id }),
        status: terminologyReason ? "BLOCKED" : "PENDING",
        dependencyReason: terminologyReason,
        correlationId: randomUUID(),
      },
    });
  }
  return encounterEvent;
}

async function buildVisitEncounter(event: {
  id: string;
  clinicId: number;
  payloadEncrypted: string;
}) {
  const payload = visitPayloadSchema.parse(
    decryptHieJson(event.payloadEncrypted)
  );
  const visit = await db.visit.findFirst({
    where: { id: payload.visitId, clinicId: event.clinicId },
    select: {
      patientId: true,
      doctorId: true,
      branchId: true,
      startTime: true,
      endTime: true,
      patient: {
        select: {
          externalIdentities: {
            where: {
              verificationStatus: "VERIFIED",
              resourceIdEncrypted: { not: null },
            },
            take: 1,
          },
        },
      },
    },
  });
  if (!visit) {
    throw new HieDependencyError("VISIT_NOT_FOUND", "Visit no longer exists");
  }
  const now = new Date();
  const activeConsent = await db.hieConsent.findFirst({
    where: {
      clinicId: event.clinicId,
      patientId: visit.patientId,
      status: "ACTIVE",
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    select: { id: true },
  });
  if (!activeConsent) {
    throw new HieDependencyError(
      "ACTIVE_CONSENT_REQUIRED",
      "Active HIE sharing consent is required"
    );
  }
  const patientIdentity = visit.patient.externalIdentities[0];
  if (!patientIdentity?.resourceIdEncrypted) {
    throw new HieDependencyError(
      "PATIENT_IDENTITY_REQUIRED",
      "Verified Client Registry identity is required"
    );
  }
  if (!(visit.doctorId && visit.branchId)) {
    throw new HieDependencyError(
      "CLINICAL_REFERENCES_REQUIRED",
      "Doctor and branch references are required"
    );
  }
  const [practitioner, facility] = await Promise.all([
    db.userExternalIdentity.findFirst({
      where: {
        userId: visit.doctorId,
        verificationStatus: "VERIFIED",
      },
    }),
    db.hieFacilityLink.findFirst({
      where: {
        clinicId: event.clinicId,
        branchId: visit.branchId,
        verificationStatus: "VERIFIED",
      },
    }),
  ]);
  if (!practitioner) {
    throw new HieDependencyError(
      "PRACTITIONER_IDENTITY_REQUIRED",
      "Verified national practitioner identity is required"
    );
  }
  if (!facility) {
    throw new HieDependencyError(
      "FACILITY_IDENTITY_REQUIRED",
      "Verified national facility identity is required"
    );
  }
  return mapVisitEncounter({
    id: event.id,
    patientReference: decryptHieValue(patientIdentity.resourceIdEncrypted),
    practitionerReference: decryptHieValue(practitioner.identifierEncrypted),
    locationReference: facility.locationReference,
    startedAt: visit.startTime,
    endedAt: visit.endTime,
  });
}

async function buildTransferEncounter(event: {
  id: string;
  clinicId: number;
  payloadEncrypted: string;
}) {
  const payload = transferPayloadSchema.parse(
    decryptHieJson(event.payloadEncrypted)
  );
  const transfer = await db.hieExternalTransfer.findFirst({
    where: {
      id: payload.transferId,
      clinicId: event.clinicId,
      status: "QUEUED",
    },
    include: {
      patient: {
        select: {
          externalIdentities: {
            where: {
              verificationStatus: "VERIFIED",
              resourceIdEncrypted: { not: null },
            },
            take: 1,
          },
        },
      },
      sourceBranch: {
        select: {
          hieFacilityLinks: {
            where: { verificationStatus: "VERIFIED" },
            take: 1,
          },
        },
      },
      referringPractitioner: {
        select: {
          hieExternalIdentities: {
            where: { verificationStatus: "VERIFIED" },
            take: 1,
          },
        },
      },
      visit: { select: { id: true, startTime: true, endTime: true } },
    },
  });
  if (!transfer) {
    throw new HieDependencyError(
      "TRANSFER_NOT_FOUND",
      "External transfer no longer exists"
    );
  }
  const now = new Date();
  const consent = await db.hieConsent.findFirst({
    where: {
      clinicId: event.clinicId,
      patientId: transfer.patientId,
      status: "ACTIVE",
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
  });
  const patientIdentity = transfer.patient.externalIdentities[0];
  const practitioner = transfer.referringPractitioner.hieExternalIdentities[0];
  const facility = transfer.sourceBranch.hieFacilityLinks[0];
  const parentEncounter = await db.hieResourceLink.findUnique({
    where: {
      clinicId_localResourceType_localResourceId_hieResourceType: {
        clinicId: event.clinicId,
        localResourceType: "Visit",
        localResourceId: String(transfer.visitId),
        hieResourceType: "Encounter",
      },
    },
  });
  if (!consent) {
    throw new HieDependencyError(
      "ACTIVE_CONSENT_REQUIRED",
      "Active HIE sharing consent is required"
    );
  }
  if (!patientIdentity?.resourceIdEncrypted) {
    throw new HieDependencyError(
      "PATIENT_IDENTITY_REQUIRED",
      "Verified Client Registry identity is required"
    );
  }
  if (!practitioner) {
    throw new HieDependencyError(
      "PRACTITIONER_IDENTITY_REQUIRED",
      "Verified national practitioner identity is required"
    );
  }
  if (!facility) {
    throw new HieDependencyError(
      "FACILITY_IDENTITY_REQUIRED",
      "Verified source facility identity is required"
    );
  }
  if (!parentEncounter) {
    throw new HieDependencyError(
      "PARENT_ENCOUNTER_REQUIRED",
      "The parent visit must be published before transfer"
    );
  }
  return {
    transfer,
    patientReference: decryptHieValue(patientIdentity.resourceIdEncrypted),
    practitionerReference: decryptHieValue(practitioner.identifierEncrypted),
    resource: mapTransferEncounter({
      id: event.id,
      patientReference: decryptHieValue(patientIdentity.resourceIdEncrypted),
      practitionerReference: decryptHieValue(practitioner.identifierEncrypted),
      locationReference: transfer.destinationLocationReference,
      originReference: facility.locationReference,
      destinationReference: transfer.destinationLocationReference,
      parentEncounterReference: decryptHieValue(
        parentEncounter.hieResourceIdEncrypted
      ),
      reason: transfer.reason,
      startedAt: transfer.visit.startTime,
      endedAt: transfer.visit.endTime,
    }),
  };
}

async function buildVisitCondition(event: {
  id: string;
  clinicId: number;
  payloadEncrypted: string;
}) {
  const payload = conditionPayloadSchema.parse(
    decryptHieJson(event.payloadEncrypted)
  );
  const diagnosis = await db.visitDiagnosis.findFirst({
    where: { id: payload.diagnosisId, visit: { clinicId: event.clinicId } },
    select: {
      id: true,
      icd11Code: true,
      description: true,
      createdAt: true,
      visit: {
        select: {
          id: true,
          doctorId: true,
          patient: {
            select: {
              id: true,
              externalIdentities: {
                where: {
                  verificationStatus: "VERIFIED",
                  resourceIdEncrypted: { not: null },
                },
                take: 1,
              },
            },
          },
        },
      },
    },
  });
  if (!diagnosis?.icd11Code) {
    throw new HieDependencyError(
      "ICD11_CODE_REQUIRED",
      "ICD-11 code is required for Condition publication"
    );
  }
  if (!diagnosis.visit.doctorId) {
    throw new HieDependencyError(
      "PRACTITIONER_IDENTITY_REQUIRED",
      "Visit doctor is required for Condition publication"
    );
  }
  const [practitioner, encounter, consent] = await Promise.all([
    db.userExternalIdentity.findFirst({
      where: {
        userId: diagnosis.visit.doctorId,
        verificationStatus: "VERIFIED",
      },
    }),
    db.hieResourceLink.findUnique({
      where: {
        clinicId_localResourceType_localResourceId_hieResourceType: {
          clinicId: event.clinicId,
          localResourceType: "Visit",
          localResourceId: String(diagnosis.visit.id),
          hieResourceType: "Encounter",
        },
      },
    }),
    db.hieConsent.findFirst({
      where: {
        clinicId: event.clinicId,
        patientId: diagnosis.visit.patient.id,
        status: "ACTIVE",
        effectiveFrom: { lte: new Date() },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }],
      },
      select: { id: true },
    }),
  ]);
  const patientIdentity = diagnosis.visit.patient.externalIdentities[0];
  if (!patientIdentity?.resourceIdEncrypted) {
    throw new HieDependencyError(
      "PATIENT_IDENTITY_REQUIRED",
      "Verified Client Registry identity is required"
    );
  }
  if (!consent) {
    throw new HieDependencyError(
      "ACTIVE_CONSENT_REQUIRED",
      "Active HIE sharing consent is required"
    );
  }
  if (!practitioner) {
    throw new HieDependencyError(
      "PRACTITIONER_IDENTITY_REQUIRED",
      "Verified national practitioner identity is required"
    );
  }
  if (!encounter) {
    throw new HieDependencyError(
      "PARENT_ENCOUNTER_REQUIRED",
      "The visit Encounter must be published before its Conditions"
    );
  }
  return {
    diagnosisId: diagnosis.id,
    resource: mapVisitCondition({
      id: event.id,
      patientReference: decryptHieValue(patientIdentity.resourceIdEncrypted),
      practitionerReference: decryptHieValue(practitioner.identifierEncrypted),
      encounterReference: decryptHieValue(encounter.hieResourceIdEncrypted),
      icd11Code: diagnosis.icd11Code,
      description: diagnosis.description,
      recordedAt: diagnosis.createdAt,
    }),
  };
}

async function resourceAlreadyExists(params: {
  resourceType: string;
  resourceId: string;
  correlationId: string;
}) {
  try {
    await rhieRequest({
      service: "SHR",
      method: "GET",
      path: `${params.resourceType}/${params.resourceId}`,
      correlationId: params.correlationId,
    });
    return true;
  } catch (error) {
    if (error instanceof RhieRequestError && error.status === 404) {
      return false;
    }
    throw error;
  }
}

async function postWithRetryVerification(params: {
  eventAttemptCount: number;
  postPath: string;
  resourceType: string;
  resourceId: string;
  body: unknown;
  correlationId: string;
  verifyOnRetry?: boolean;
}) {
  if (
    params.eventAttemptCount > 0 &&
    params.verifyOnRetry !== false &&
    (await resourceAlreadyExists(params))
  ) {
    return { status: 200 };
  }
  return rhieRequest({
    service: "SHR",
    method: "POST",
    path: params.postPath,
    body: params.body,
    correlationId: params.correlationId,
  });
}

async function processEvent(event: {
  id: string;
  clinicId: number;
  resourceType: string;
  payloadEncrypted: string;
  correlationId: string;
  attemptCount: number;
}) {
  if (event.resourceType === "TransferEncounter") {
    const {
      transfer,
      resource: transferResource,
      patientReference,
      practitionerReference,
    } = await buildTransferEncounter(event);
    const response = await postWithRetryVerification({
      eventAttemptCount: event.attemptCount,
      postPath: "Encounter/transfer",
      resourceType: "Encounter",
      resourceId: transferResource.id,
      body: transferResource,
      correlationId: event.correlationId,
    });
    const summary = mapTransferIpsBundle({
      id: event.id,
      patientReference,
      practitionerReference,
      clinicalSummary: transfer.clinicalSummary,
      encounter: transferResource,
      authoredAt: new Date(),
    });
    await postWithRetryVerification({
      eventAttemptCount: event.attemptCount,
      postPath: "Bundle/$submit-ips",
      resourceType: "Bundle",
      resourceId: summary.id,
      body: summary,
      correlationId: event.correlationId,
      verifyOnRetry: false,
    });
    await db.$transaction([
      db.hieExternalTransfer.update({
        where: { id: transfer.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          hieEncounterIdEncrypted: encryptHieValue(transferResource.id),
        },
      }),
      db.hieSyncAttempt.create({
        data: {
          eventId: event.id,
          attemptNumber: event.attemptCount + 1,
          httpStatus: response.status,
          outcome: "SUCCEEDED",
        },
      }),
      db.hieOutboxEvent.update({
        where: { id: event.id },
        data: {
          status: "SUCCEEDED",
          attemptCount: { increment: 1 },
          completedAt: new Date(),
          lockedAt: null,
        },
      }),
    ]);
    return;
  }
  if (event.resourceType === "Condition") {
    const { diagnosisId, resource: conditionResource } =
      await buildVisitCondition(event);
    const startedAt = Date.now();
    const response = await postWithRetryVerification({
      eventAttemptCount: event.attemptCount,
      postPath: "Condition",
      resourceType: "Condition",
      resourceId: conditionResource.id,
      body: conditionResource,
      correlationId: event.correlationId,
    });
    await db.$transaction(async (tx) => {
      await tx.hieResourceLink.upsert({
        where: {
          clinicId_localResourceType_localResourceId_hieResourceType: {
            clinicId: event.clinicId,
            localResourceType: "VisitDiagnosis",
            localResourceId: String(diagnosisId),
            hieResourceType: "Condition",
          },
        },
        create: {
          clinicId: event.clinicId,
          localResourceType: "VisitDiagnosis",
          localResourceId: String(diagnosisId),
          hieResourceType: "Condition",
          hieResourceIdHash: hashHieIdentifier(conditionResource.id),
          hieResourceIdEncrypted: encryptHieValue(conditionResource.id),
          lastSyncedAt: new Date(),
        },
        update: { lastSyncedAt: new Date() },
      });
      await tx.hieSyncAttempt.create({
        data: {
          eventId: event.id,
          attemptNumber: event.attemptCount + 1,
          httpStatus: response.status,
          outcome: "SUCCEEDED",
          durationMs: Date.now() - startedAt,
        },
      });
      await tx.hieOutboxEvent.update({
        where: { id: event.id },
        data: {
          status: "SUCCEEDED",
          attemptCount: { increment: 1 },
          completedAt: new Date(),
          lockedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
    });
    return;
  }
  if (event.resourceType !== "Encounter") {
    throw new HieDependencyError(
      "RESOURCE_NOT_IMPLEMENTED",
      `Unsupported outbox resource ${event.resourceType}`
    );
  }
  const resource = await buildVisitEncounter(event);
  const startedAt = Date.now();
  const response = await postWithRetryVerification({
    eventAttemptCount: event.attemptCount,
    postPath: "Encounter",
    resourceType: "Encounter",
    resourceId: resource.id,
    body: resource,
    correlationId: event.correlationId,
  });
  const payload = visitPayloadSchema.parse(
    decryptHieJson(event.payloadEncrypted)
  );
  await db.$transaction(async (tx) => {
    await tx.hieResourceLink.upsert({
      where: {
        clinicId_localResourceType_localResourceId_hieResourceType: {
          clinicId: event.clinicId,
          localResourceType: "Visit",
          localResourceId: String(payload.visitId),
          hieResourceType: "Encounter",
        },
      },
      create: {
        clinicId: event.clinicId,
        localResourceType: "Visit",
        localResourceId: String(payload.visitId),
        hieResourceType: "Encounter",
        hieResourceIdHash: hashHieIdentifier(resource.id),
        hieResourceIdEncrypted: encryptHieValue(resource.id),
        lastSyncedAt: new Date(),
      },
      update: { lastSyncedAt: new Date() },
    });
    await tx.hieSyncAttempt.create({
      data: {
        eventId: event.id,
        attemptNumber: event.attemptCount + 1,
        httpStatus: response.status,
        outcome: "SUCCEEDED",
        durationMs: Date.now() - startedAt,
      },
    });
    await tx.hieOutboxEvent.update({
      where: { id: event.id },
      data: {
        status: "SUCCEEDED",
        attemptCount: { increment: 1 },
        completedAt: new Date(),
        lockedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
  });
}

async function recordFailure(
  event: {
    id: string;
    attemptCount: number;
    resourceType: string;
    payloadEncrypted: string;
  },
  error: unknown
) {
  const attemptNumber = event.attemptCount + 1;
  const dependency = error instanceof HieDependencyError;
  const requestError = error instanceof RhieRequestError ? error : null;
  const exhausted = attemptNumber >= MAX_ATTEMPTS;
  let status: "BLOCKED" | "RETRY" | "DEAD_LETTER" = "DEAD_LETTER";
  if (dependency) {
    status = "BLOCKED";
  } else if (requestError?.retryable && !exhausted) {
    status = "RETRY";
  }
  const delay =
    RETRY_DELAYS_MS[Math.min(attemptNumber - 1, RETRY_DELAYS_MS.length - 1)];
  const code = dependency
    ? error.code
    : (requestError?.code ?? "HIE_PUBLICATION_FAILED");
  let message = "HIE publication failed";
  if (dependency) {
    message = error.message;
  } else if (requestError) {
    message = requestError.message;
  }
  await db.$transaction([
    db.hieSyncAttempt.create({
      data: {
        eventId: event.id,
        attemptNumber,
        httpStatus: requestError?.status,
        outcome: status,
        errorCode: code,
        errorMessage: message,
      },
    }),
    db.hieOutboxEvent.update({
      where: { id: event.id },
      data: {
        status,
        dependencyReason: dependency ? message : null,
        attemptCount: { increment: 1 },
        nextAttemptAt: new Date(Date.now() + delay),
        lockedAt: null,
        lastErrorCode: code,
        lastErrorMessage: message,
      },
    }),
  ]);
  if (event.resourceType === "TransferEncounter") {
    const payload = transferPayloadSchema.safeParse(
      decryptHieJson(event.payloadEncrypted)
    );
    if (payload.success) {
      await db.hieExternalTransfer.updateMany({
        where: { id: payload.data.transferId, status: "QUEUED" },
        data: {
          status: status === "RETRY" ? "QUEUED" : "FAILED",
          acknowledgement: message,
        },
      });
    }
  }
}

export async function processHieOutbox(limit = 20) {
  await db.hieOutboxEvent.updateMany({
    where: {
      status: "PROCESSING",
      lockedAt: { lt: new Date(Date.now() - 15 * 60_000) },
    },
    data: {
      status: "RETRY",
      lockedAt: null,
      nextAttemptAt: new Date(),
      attemptCount: { increment: 1 },
      lastErrorCode: "WORKER_LEASE_EXPIRED",
      lastErrorMessage: "Publication worker lease expired before completion",
    },
  });
  const candidates = await db.hieOutboxEvent.findMany({
    where: {
      status: { in: ["PENDING", "RETRY"] },
      nextAttemptAt: { lte: new Date() },
    },
    orderBy: [{ dependencyOrder: "asc" }, { createdAt: "asc" }],
    take: limit,
  });
  let processed = 0;
  for (const candidate of candidates) {
    const claimed = await db.hieOutboxEvent.updateMany({
      where: {
        id: candidate.id,
        status: { in: ["PENDING", "RETRY"] },
        lockedAt: null,
      },
      data: { status: "PROCESSING", lockedAt: new Date() },
    });
    if (claimed.count !== 1) {
      continue;
    }
    try {
      await processEvent(candidate);
    } catch (error) {
      await recordFailure(candidate, error);
    }
    processed += 1;
  }
  if (processed > 0) {
    logger.info("hie.outbox.cycle_completed", { processed });
  }
  return processed;
}

export function retryHieEvent(params: { clinicId: number; eventId: string }) {
  return db.hieOutboxEvent.updateMany({
    where: {
      id: params.eventId,
      clinicId: params.clinicId,
      status: { in: ["BLOCKED", "DEAD_LETTER", "RETRY"] },
    },
    data: {
      status: "PENDING",
      dependencyReason: null,
      nextAttemptAt: new Date(),
      lockedAt: null,
    },
  });
}
