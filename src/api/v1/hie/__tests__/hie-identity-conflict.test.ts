import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Context } from "hono";
import type { AppEnv } from "@/middlewares/auth.middleware";

process.env.HIE_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

let conflictingPatientId = 99;
let existingVerificationStatus = "PENDING";
let rolledBack = false;
let recordedAfterRollback = false;
let upsertArgs:
  | {
      update?: Record<string, unknown>;
      where?: Record<string, unknown>;
    }
  | undefined;

const transactionClient = {
  patientExternalIdentity: {
    findUnique: mock(() =>
      Promise.resolve({
        patientId: conflictingPatientId,
        verificationStatus: existingVerificationStatus,
      })
    ),
    upsert: mock(
      (args: {
        update?: Record<string, unknown>;
        where?: Record<string, unknown>;
      }) => {
        upsertArgs = args;
        return Promise.resolve({
          id: 1,
          patientId: conflictingPatientId,
          identifierType: "NID",
          verificationStatus: "PENDING",
        });
      }
    ),
  },
  patient: { update: mock(() => Promise.resolve({ id: 7 })) },
};

const reconciliationCreate = mock(() => {
  recordedAfterRollback = rolledBack;
  return Promise.resolve({ id: 1 });
});
const auditCreate = mock(() => Promise.resolve({ id: 1 }));

mock.module("@/database/db", () => ({
  db: {
    hieTenantConfig: {
      findUnique: mock(() =>
        Promise.resolve({ enabled: true, clientRegistryEnabled: true })
      ),
    },
    patient: {
      findFirst: mock(() =>
        Promise.resolve({
          id: 7,
          updatedAt: new Date("2026-08-09T00:00:00.000Z"),
        })
      ),
    },
    patientExternalIdentity: {
      findFirst: mock(() =>
        Promise.resolve({ patientId: conflictingPatientId })
      ),
    },
    $transaction: async (
      callback: (tx: typeof transactionClient) => Promise<unknown>
    ) => {
      try {
        return await callback(transactionClient);
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    },
    hieIdentityReconciliation: { create: reconciliationCreate },
    hieAuditEvent: { create: auditCreate },
  },
}));

mock.module("@/services/hie/client-registry.service", () => ({
  lookupNationalPatient: mock(() =>
    Promise.resolve({
      correlationId: "correlation-1",
      matches: [{ externalPatientId: "national-patient-1" }],
    })
  ),
}));

mock.module("@/services/hie/outbox.service", () => ({
  resumeBlockedPatientEvents: mock(() => Promise.resolve(0)),
  retryHieEvent: mock(() => Promise.resolve({ count: 0 })),
}));

let deferVerification: typeof import("../hie.controller").deferVerification;
let linkPatient: typeof import("../hie.controller").linkPatient;

beforeAll(async () => {
  ({ deferVerification, linkPatient } = await import("../hie.controller"));
});

beforeEach(() => {
  conflictingPatientId = 99;
  existingVerificationStatus = "PENDING";
  rolledBack = false;
  recordedAfterRollback = false;
  upsertArgs = undefined;
  transactionClient.patientExternalIdentity.findUnique.mockClear();
  transactionClient.patientExternalIdentity.upsert.mockClear();
  reconciliationCreate.mockClear();
  auditCreate.mockClear();
});

function context(input: Record<string, unknown>): Context<AppEnv> {
  return {
    get: (key: string) => {
      if (key === "clinicId") {
        return 3;
      }
      if (key === "user") {
        return { id: 5 };
      }
      if (key === "validatedJson") {
        return input;
      }
      return key === "locale" ? "en" : undefined;
    },
    header: () => {
      // Response headers are outside these transaction assertions.
    },
    json: (body: unknown, status?: number) => ({ body, status }),
  } as unknown as Context<AppEnv>;
}

async function captureError(operation: Promise<unknown>): Promise<unknown> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  return caught;
}

describe("patient identity conflict handling", () => {
  it("rolls back and records a linkPatient conflict", async () => {
    const caught = await captureError(
      linkPatient(
        context({
          patientId: 7,
          nid: "1234567890123456",
          birthDate: "1990-01-01",
          externalPatientId: "national-patient-1",
          expectedPatientUpdatedAt: "2026-08-09T00:00:00.000Z",
          reviewedFields: [],
        })
      )
    );
    expect(caught).toMatchObject({ code: "HIE_IDENTITY_ALREADY_LINKED" });
    expect(rolledBack).toBe(true);
    expect(recordedAfterRollback).toBe(true);
    expect(
      transactionClient.patientExternalIdentity.upsert
    ).not.toHaveBeenCalled();
  });

  it("rolls back and records a deferVerification conflict", async () => {
    const caught = await captureError(
      deferVerification(
        context({
          patientId: 7,
          nid: "1234567890123456",
          birthDate: "1990-01-01",
          reason: "REGISTRY_UNAVAILABLE",
        })
      )
    );
    expect(caught).toMatchObject({ code: "HIE_IDENTITY_ALREADY_LINKED" });
    expect(rolledBack).toBe(true);
    expect(recordedAfterRollback).toBe(true);
    expect(
      transactionClient.patientExternalIdentity.upsert
    ).not.toHaveBeenCalled();
  });

  it("preserves the same-patient defer path without updating patientId", async () => {
    conflictingPatientId = 7;

    await deferVerification(
      context({
        patientId: 7,
        nid: "1234567890123456",
        birthDate: "1990-01-01",
        reason: "REGISTRY_UNAVAILABLE",
      })
    );

    expect(rolledBack).toBe(false);
    expect(upsertArgs?.update).not.toHaveProperty("patientId");
    expect(upsertArgs?.where).toMatchObject({
      verificationStatus: { not: "VERIFIED" },
    });
    expect(reconciliationCreate).not.toHaveBeenCalled();
  });

  it("preserves an existing verified identity when verification is deferred", async () => {
    conflictingPatientId = 7;
    existingVerificationStatus = "VERIFIED";

    const caught = await captureError(
      deferVerification(
        context({
          patientId: 7,
          nid: "1234567890123456",
          birthDate: "1990-01-01",
          reason: "REGISTRY_UNAVAILABLE",
        })
      )
    );

    expect(caught).toMatchObject({ code: "HIE_IDENTITY_ALREADY_VERIFIED" });
    expect(rolledBack).toBe(true);
    expect(
      transactionClient.patientExternalIdentity.upsert
    ).not.toHaveBeenCalled();
    expect(reconciliationCreate).not.toHaveBeenCalled();
  });
});
