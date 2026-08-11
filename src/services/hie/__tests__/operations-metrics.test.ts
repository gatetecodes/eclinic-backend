import { beforeAll, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../../../../generated/prisma/client";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

let getHieOperationsSummary: typeof import("../operations-metrics.service").getHieOperationsSummary;

beforeAll(async () => {
  ({ getHieOperationsSummary } = await import("../operations-metrics.service"));
});

describe("HIE operational metrics tenancy and alerts", () => {
  it("scopes every metric query to the requested clinic", async () => {
    const seenClinicIds: number[] = [];
    const capture = (args: {
      where?: { clinicId?: number; user?: { clinicId?: number } };
    }) => {
      const clinicId = args.where?.clinicId ?? args.where?.user?.clinicId;
      if (clinicId) {
        seenClinicIds.push(clinicId);
      }
    };
    const client = {
      hieTenantConfig: {
        findUnique: (args: { where: { clinicId: number } }) => {
          seenClinicIds.push(args.where.clinicId);
          return Promise.resolve({
            enabled: true,
            clientRegistryEnabled: true,
            sharedRecordReadEnabled: true,
            sharedRecordWriteEnabled: true,
            transferEnabled: true,
            lastHealthStatus: "DEGRADED",
            lastHealthCheckedAt: new Date("2026-08-11T08:00:00.000Z"),
          });
        },
      },
      hieOutboxEvent: {
        groupBy: (args: { by: string[]; where: { clinicId: number } }) => {
          capture(args);
          return Promise.resolve(
            args.by[0] === "status"
              ? [
                  { status: "SUCCEEDED", _count: { _all: 8 } },
                  { status: "DEAD_LETTER", _count: { _all: 2 } },
                ]
              : [{ resourceType: "Observation", _count: { _all: 10 } }]
          );
        },
        findFirst: (args: { where: { clinicId: number } }) => {
          capture(args);
          return Promise.resolve({
            createdAt: new Date("2026-08-11T07:00:00.000Z"),
          });
        },
        count: (args: { where: { clinicId: number } }) => {
          capture(args);
          return Promise.resolve(1);
        },
      },
      hieSyncAttempt: {
        groupBy: (args: { where: { event: { clinicId: number } } }) => {
          seenClinicIds.push(args.where.event.clinicId);
          return Promise.resolve([
            { outcome: "SUCCEEDED", _count: { _all: 4 } },
            { outcome: "RETRY", _count: { _all: 2 } },
          ]);
        },
        aggregate: (args: { where: { event: { clinicId: number } } }) => {
          seenClinicIds.push(args.where.event.clinicId);
          return Promise.resolve({
            _avg: { durationMs: 150 },
            _max: { durationMs: 400 },
          });
        },
      },
      hieFacilityLink: {
        groupBy: (args: { where: { clinicId: number } }) => {
          capture(args);
          return Promise.resolve([
            { verificationStatus: "VERIFIED", _count: { _all: 1 } },
            { verificationStatus: "PENDING", _count: { _all: 1 } },
          ]);
        },
        count: (args: { where: { clinicId: number } }) => {
          capture(args);
          return Promise.resolve(0);
        },
      },
      userExternalIdentity: {
        groupBy: (args: { where: { user: { clinicId: number } } }) => {
          capture(args);
          return Promise.resolve([]);
        },
        count: (args: { where: { user: { clinicId: number } } }) => {
          capture(args);
          return Promise.resolve(0);
        },
      },
      hieDestinationFacility: {
        groupBy: (args: { where: { clinicId: number } }) => {
          capture(args);
          return Promise.resolve([]);
        },
        count: (args: { where: { clinicId: number } }) => {
          capture(args);
          return Promise.resolve(0);
        },
      },
      patientInsuranceExternalIdentity: {
        groupBy: (args: { where: { clinicId: number } }) => {
          capture(args);
          return Promise.resolve([]);
        },
        count: (args: { where: { clinicId: number } }) => {
          capture(args);
          return Promise.resolve(0);
        },
      },
      hieConsent: {
        groupBy: (args: { where: { clinicId: number } }) => {
          capture(args);
          return Promise.resolve([]);
        },
      },
      hieEmergencyAccess: {
        count: (args: { where: { clinicId: number } }) => {
          capture(args);
          return Promise.resolve(0);
        },
      },
      hieClinicalConcept: {
        groupBy: () => Promise.resolve([]),
      },
    } as unknown as PrismaClient;

    const summary = await getHieOperationsSummary({
      clinicId: 17,
      hours: 24,
      client,
    });

    expect(seenClinicIds).toHaveLength(19);
    expect(new Set(seenClinicIds)).toEqual(new Set([17]));
    expect(summary.attempts).toMatchObject({
      total: 6,
      succeeded: 4,
      averageLatencyMs: 150,
      maximumLatencyMs: 400,
    });
    expect(summary.alerts.map((alert) => alert.code)).toEqual([
      "DEAD_LETTER_PRESENT",
      "STALE_PUBLICATION",
      "HEALTH_DEGRADED",
      "UNVERIFIED_FACILITY",
      "HIGH_FAILURE_RATE",
    ]);
  });
});
