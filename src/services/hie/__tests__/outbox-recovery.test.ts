import { beforeAll, describe, expect, it } from "bun:test";
import type { Prisma, PrismaClient } from "../../../../generated/prisma/client";
import { decryptHieJson } from "../hie-crypto.service";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.HIE_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

let recoverMissingFinalizedVisitEvents: typeof import("../outbox.service").recoverMissingFinalizedVisitEvents;
let resumeBlockedPatientEvents: typeof import("../outbox.service").resumeBlockedPatientEvents;
let resumeBlockedHieDependencies: typeof import("../outbox.service").resumeBlockedHieDependencies;

beforeAll(async () => {
  ({
    recoverMissingFinalizedVisitEvents,
    resumeBlockedHieDependencies,
    resumeBlockedPatientEvents,
  } = await import("../outbox.service"));
});

describe("finalized visit outbox recovery", () => {
  it("enqueues a missing encounter and its conditions", async () => {
    const createdResourceTypes: string[] = [];
    let conditionEvents: Prisma.HieOutboxEventCreateManyInput[] = [];
    let createManyCalls = 0;
    const transactionClient = {
      hieTenantConfig: {
        findUnique: async () => ({
          enabled: true,
          sharedRecordWriteEnabled: true,
        }),
      },
      hieOutboxEvent: {
        findFirst: async () => null,
        create: ({ data }: { data: { resourceType: string } }) => {
          createdResourceTypes.push(data.resourceType);
          return { id: `event-${createdResourceTypes.length}`, ...data };
        },
        createMany: ({
          data,
        }: {
          data: Prisma.HieOutboxEventCreateManyInput[];
        }) => {
          createManyCalls += 1;
          conditionEvents = data;
          createdResourceTypes.push(...data.map((event) => event.resourceType));
          return { count: data.length };
        },
      },
      patientExternalIdentity: {
        findFirst: async () => ({ id: 1 }),
      },
      hieConsent: {
        findFirst: async () => ({ id: 1 }),
      },
      visit: {
        findFirst: async () => ({
          id: 4,
          patientId: 3,
          doctorId: 9,
          branchId: 5,
          startTime: new Date("2026-08-10T08:00:00.000Z"),
          endTime: null,
          updatedAt: new Date("2026-08-10T09:00:00.000Z"),
        }),
      },
      visitDiagnosis: {
        findMany: async () => [
          {
            id: 11,
            icd11Code: "1A00",
            description: "Cholera",
            createdAt: new Date("2026-08-10T08:30:00.000Z"),
          },
          {
            id: 12,
            icd11Code: null,
            description: "Uncoded diagnosis",
            createdAt: new Date("2026-08-10T08:45:00.000Z"),
          },
        ],
      },
      triage: { findUnique: async () => null },
      exam: { findMany: async () => [] },
      examResult: { findMany: async () => [] },
      prescription: { findMany: async () => [] },
      pharmacyDispenseOrder: { findMany: async () => [] },
      treatment: { findMany: async () => [] },
      hospitalization: { findUnique: async () => null },
    };
    const client = {
      $queryRaw: (query: { strings: readonly string[] }) => {
        const sql = query.strings.join(" ");
        expect(sql).toContain("visit.status = 'FINALIZED'");
        expect(sql).toContain("NOT EXISTS");
        return [{ clinicId: 2, patientId: 3, visitId: 4 }];
      },
      $transaction: (
        callback: (tx: typeof transactionClient) => Promise<unknown>
      ) => callback(transactionClient),
    } as unknown as PrismaClient;

    await expect(recoverMissingFinalizedVisitEvents(client)).resolves.toBe(1);
    expect(createManyCalls).toBe(1);
    expect(createdResourceTypes).toEqual([
      "Encounter",
      "Condition",
      "Condition",
    ]);
    expect(conditionEvents.map((event) => event.status)).toEqual([
      "PENDING",
      "BLOCKED",
    ]);
    expect(conditionEvents.map((event) => event.dependencyReason)).toEqual([
      null,
      "ICD-11 code is required for Condition publication",
    ]);
    expect(
      conditionEvents.map((event) => decryptHieJson(event.payloadEncrypted))
    ).toEqual([
      {
        diagnosisId: 11,
        visitId: 4,
        patientId: 3,
        doctorId: 9,
        icd11Code: "1A00",
        description: "Cholera",
        recordedAt: "2026-08-10T08:30:00.000Z",
      },
      {
        diagnosisId: 12,
        visitId: 4,
        patientId: 3,
        doctorId: 9,
        icd11Code: null,
        description: "Uncoded diagnosis",
        recordedAt: "2026-08-10T08:45:00.000Z",
      },
    ]);
    expect(conditionEvents[0]?.correlationId).not.toBe(
      conditionEvents[1]?.correlationId
    );
  });
});

describe("blocked patient event recovery", () => {
  it("resumes only identity or consent blocked visit events", async () => {
    let updateArgs: unknown;
    const tx = {
      patientExternalIdentity: {
        findFirst: async () => ({ id: 1 }),
      },
      hieConsent: {
        findFirst: async () => ({ id: 2 }),
      },
      visit: {
        findMany: async () => [{ id: 10 }],
      },
      visitDiagnosis: {
        findMany: async () => [{ id: 20 }],
      },
      triage: {
        findMany: async () => [{ id: 30 }],
      },
      hieOutboxEvent: {
        findMany: async () => [],
        updateMany: (args: unknown) => {
          updateArgs = args;
          return { count: 2 };
        },
      },
    } as unknown as Prisma.TransactionClient;

    await expect(
      resumeBlockedPatientEvents(tx, { clinicId: 3, patientId: 4 })
    ).resolves.toBe(2);
    expect(updateArgs).toMatchObject({
      where: {
        clinicId: 3,
        status: "BLOCKED",
        dependencyReason: {
          in: [
            "Verified Client Registry identity is required",
            "Active HIE sharing consent is required",
          ],
        },
        OR: [
          { aggregateType: "Visit", aggregateId: { in: ["10"] } },
          {
            aggregateType: "VisitDiagnosis",
            aggregateId: { in: ["20"] },
          },
          {
            aggregateType: "Triage",
            aggregateId: {
              in: [
                "30:height",
                "30:weight",
                "30:temperature",
                "30:heartRate",
                "30:respiratory",
                "30:spo2",
                "30:bmi",
                "30:bloodSugar",
              ],
            },
          },
          { id: { in: [] } },
        ],
      },
      data: { status: "PENDING", dependencyReason: null, lockedAt: null },
    });
  });

  it("leaves events blocked until both patient dependencies exist", async () => {
    let updated = false;
    const tx = {
      patientExternalIdentity: { findFirst: async () => ({ id: 1 }) },
      hieConsent: { findFirst: async () => null },
      hieOutboxEvent: {
        updateMany: () => {
          updated = true;
          return { count: 1 };
        },
      },
    } as unknown as Prisma.TransactionClient;

    await expect(
      resumeBlockedPatientEvents(tx, { clinicId: 3, patientId: 4 })
    ).resolves.toBe(0);
    expect(updated).toBe(false);
  });
});

describe("scheduled dependency recovery", () => {
  it("requeues only due blocked dependencies below the attempt limit", async () => {
    let updateArgs: unknown;
    const client = {
      hieOutboxEvent: {
        updateMany: (args: unknown) => {
          updateArgs = args;
          return Promise.resolve({ count: 3 });
        },
      },
    } as unknown as PrismaClient;
    const now = new Date("2026-08-11T10:00:00.000Z");

    await expect(resumeBlockedHieDependencies(client, now)).resolves.toEqual({
      count: 3,
    });
    expect(updateArgs).toMatchObject({
      where: {
        status: "BLOCKED",
        nextAttemptAt: { lte: now },
        attemptCount: { lt: 8 },
      },
      data: {
        status: "PENDING",
        dependencyReason: null,
        lockedAt: null,
      },
    });
  });
});
