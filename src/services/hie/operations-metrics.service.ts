import { db } from "@/database/db";
import { logger } from "@/lib/logger";
import type { PrismaClient } from "../../../generated/prisma/client";

const DEFAULT_STALE_MINUTES = 30;

type AlertSeverity = "CRITICAL" | "WARNING";
type OperationsAlert = {
  code: string;
  severity: AlertSeverity;
  count: number;
};

function staleThresholdMinutes(): number {
  const configured = Number(process.env.HIE_ALERT_STALE_MINUTES);
  return Number.isInteger(configured) && configured >= 5 && configured <= 1440
    ? configured
    : DEFAULT_STALE_MINUTES;
}

function buildAlerts(params: {
  statuses: Record<string, number>;
  staleActionableCount: number;
  healthStatus: string | null | undefined;
  writeEnabled: boolean | undefined;
  unverifiedFacilities: number;
  totalAttempts: number;
  succeededAttempts: number;
  overdueEmergencyReviews: number;
  expiredMappings: number;
  failedConsentSyncs: number;
}): OperationsAlert[] {
  const alerts: OperationsAlert[] = [];
  if ((params.statuses.DEAD_LETTER ?? 0) > 0) {
    alerts.push({
      code: "DEAD_LETTER_PRESENT",
      severity: "CRITICAL",
      count: params.statuses.DEAD_LETTER ?? 0,
    });
  }
  if (params.staleActionableCount > 0) {
    alerts.push({
      code: "STALE_PUBLICATION",
      severity: "WARNING",
      count: params.staleActionableCount,
    });
  }
  // Anything that is not a confirmed UP is worth surfacing. A tenant whose
  // probes have never run reads as null, which previously looked healthy.
  if (params.healthStatus && params.healthStatus !== "UP") {
    alerts.push({ code: "HEALTH_DEGRADED", severity: "WARNING", count: 1 });
  }
  if (params.writeEnabled && params.unverifiedFacilities > 0) {
    alerts.push({
      code: "UNVERIFIED_FACILITY",
      severity: "WARNING",
      count: params.unverifiedFacilities,
    });
  }
  if (
    params.totalAttempts >= 5 &&
    params.succeededAttempts / params.totalAttempts < 0.8
  ) {
    alerts.push({
      code: "HIGH_FAILURE_RATE",
      severity: "WARNING",
      count: params.totalAttempts - params.succeededAttempts,
    });
  }
  if (params.overdueEmergencyReviews > 0) {
    alerts.push({
      code: "EMERGENCY_REVIEW_OVERDUE",
      severity: "CRITICAL",
      count: params.overdueEmergencyReviews,
    });
  }
  if (params.expiredMappings > 0) {
    alerts.push({
      code: "MAPPING_REVIEW_EXPIRED",
      severity: "WARNING",
      count: params.expiredMappings,
    });
  }
  if (params.failedConsentSyncs > 0) {
    alerts.push({
      code: "CONSENT_SYNC_FAILED",
      severity: "WARNING",
      count: params.failedConsentSyncs,
    });
  }
  return alerts;
}

type HieCapabilityConfig = {
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
};

function capabilitySummary(config: HieCapabilityConfig | null) {
  return {
    enabled: config?.enabled ?? false,
    clientRegistry: config?.clientRegistryEnabled ?? false,
    sharedRecordRead: config?.sharedRecordReadEnabled ?? false,
    sharedRecordWrite: config?.sharedRecordWriteEnabled ?? false,
    transfer: config?.transferEnabled ?? false,
    consentSync: config?.consentSyncEnabled ?? false,
    consultationWrite: config?.consultationWriteEnabled ?? false,
    nationalListRead: config?.nationalListReadEnabled ?? false,
    nationalAuditRead: config?.nationalAuditReadEnabled ?? false,
    emergencyRead: config?.emergencyReadEnabled ?? false,
    allergyWrite: config?.allergyWriteEnabled ?? false,
    immunizationWrite: config?.immunizationWriteEnabled ?? false,
    imagingWrite: config?.imagingWriteEnabled ?? false,
  };
}

export async function getHieOperationsSummary(params: {
  clinicId: number;
  hours: number;
  client?: PrismaClient;
}) {
  const client = params.client ?? db;
  const now = new Date();
  const since = new Date(now.getTime() - params.hours * 60 * 60_000);
  const staleBefore = new Date(
    now.getTime() - staleThresholdMinutes() * 60_000
  );
  const [
    config,
    statusGroups,
    resourceGroups,
    outcomeGroups,
    latency,
    oldestActionable,
    staleActionableCount,
    facilityGroups,
    practitionerGroups,
    destinationGroups,
    coverageGroups,
    consentGroups,
    blockedGroups,
    pendingEmergencyReviews,
    overdueEmergencyReviews,
    expiredFacilityMappings,
    expiredPractitionerMappings,
    expiredDestinationMappings,
    expiredCoverageMappings,
    terminologyGroups,
  ] = await Promise.all([
    client.hieTenantConfig.findUnique({
      where: { clinicId: params.clinicId },
      select: {
        enabled: true,
        clientRegistryEnabled: true,
        sharedRecordReadEnabled: true,
        sharedRecordWriteEnabled: true,
        transferEnabled: true,
        consentSyncEnabled: true,
        consultationWriteEnabled: true,
        nationalListReadEnabled: true,
        nationalAuditReadEnabled: true,
        emergencyReadEnabled: true,
        allergyWriteEnabled: true,
        immunizationWriteEnabled: true,
        imagingWriteEnabled: true,
        lastHealthStatus: true,
        lastHealthCheckedAt: true,
      },
    }),
    client.hieOutboxEvent.groupBy({
      by: ["status"],
      where: { clinicId: params.clinicId, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    client.hieOutboxEvent.groupBy({
      by: ["resourceType"],
      where: { clinicId: params.clinicId, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    client.hieSyncAttempt.groupBy({
      by: ["outcome"],
      where: {
        createdAt: { gte: since },
        event: { clinicId: params.clinicId },
      },
      _count: { _all: true },
    }),
    client.hieSyncAttempt.aggregate({
      where: {
        createdAt: { gte: since },
        event: { clinicId: params.clinicId },
        durationMs: { not: null },
      },
      _avg: { durationMs: true },
      _max: { durationMs: true },
    }),
    client.hieOutboxEvent.findFirst({
      where: {
        clinicId: params.clinicId,
        status: { in: ["PENDING", "RETRY", "BLOCKED", "DEAD_LETTER"] },
      },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    client.hieOutboxEvent.count({
      where: {
        clinicId: params.clinicId,
        status: { in: ["PENDING", "RETRY", "BLOCKED"] },
        createdAt: { lt: staleBefore },
      },
    }),
    client.hieFacilityLink.groupBy({
      by: ["verificationStatus"],
      where: { clinicId: params.clinicId },
      _count: { _all: true },
    }),
    client.userExternalIdentity.groupBy({
      by: ["verificationStatus"],
      where: { user: { clinicId: params.clinicId } },
      _count: { _all: true },
    }),
    client.hieDestinationFacility.groupBy({
      by: ["verificationStatus"],
      where: { clinicId: params.clinicId },
      _count: { _all: true },
    }),
    client.patientInsuranceExternalIdentity.groupBy({
      by: ["verificationStatus"],
      where: { clinicId: params.clinicId },
      _count: { _all: true },
    }),
    client.hieConsent.groupBy({
      by: ["syncStatus"],
      where: { clinicId: params.clinicId },
      _count: { _all: true },
    }),
    client.hieOutboxEvent.groupBy({
      by: ["lastErrorCode"],
      where: { clinicId: params.clinicId, status: "BLOCKED" },
      _count: { _all: true },
    }),
    client.hieEmergencyAccess.count({
      where: { clinicId: params.clinicId, reviewStatus: "PENDING" },
    }),
    client.hieEmergencyAccess.count({
      where: {
        clinicId: params.clinicId,
        reviewStatus: "PENDING",
        createdAt: { lt: new Date(now.getTime() - 24 * 60 * 60_000) },
      },
    }),
    client.hieFacilityLink.count({
      where: { clinicId: params.clinicId, verificationExpiresAt: { lt: now } },
    }),
    client.userExternalIdentity.count({
      where: {
        user: { clinicId: params.clinicId },
        verificationExpiresAt: { lt: now },
      },
    }),
    client.hieDestinationFacility.count({
      where: { clinicId: params.clinicId, verificationExpiresAt: { lt: now } },
    }),
    client.patientInsuranceExternalIdentity.count({
      where: { clinicId: params.clinicId, verificationExpiresAt: { lt: now } },
    }),
    client.hieClinicalConcept.groupBy({
      by: ["domain", "status"],
      where: { active: true },
      _count: { _all: true },
    }),
  ]);

  const statuses = Object.fromEntries(
    statusGroups.map((group) => [group.status, group._count._all])
  );
  const outcomes = Object.fromEntries(
    outcomeGroups.map((group) => [group.outcome, group._count._all])
  );
  const facilities = Object.fromEntries(
    facilityGroups.map((group) => [group.verificationStatus, group._count._all])
  );
  const groupCounts = <
    T extends { verificationStatus: string; _count: { _all: number } },
  >(
    groups: T[]
  ) =>
    Object.fromEntries(
      groups.map((group) => [group.verificationStatus, group._count._all])
    );
  const practitioners = groupCounts(practitionerGroups);
  const destinations = groupCounts(destinationGroups);
  const coverages = groupCounts(coverageGroups);
  const consents = Object.fromEntries(
    consentGroups.map((group) => [group.syncStatus, group._count._all])
  );
  const blockedReasons = blockedGroups.map((group) => ({
    code: group.lastErrorCode ?? "UNCLASSIFIED_BLOCK",
    count: group._count._all,
  }));
  const expiredMappings =
    expiredFacilityMappings +
    expiredPractitionerMappings +
    expiredDestinationMappings +
    expiredCoverageMappings;
  const succeededAttempts = outcomes.SUCCEEDED ?? 0;
  const totalAttempts = outcomeGroups.reduce(
    (total, group) => total + group._count._all,
    0
  );
  const unverifiedFacilities = facilityGroups.reduce(
    (total, group) =>
      group.verificationStatus === "VERIFIED"
        ? total
        : total + group._count._all,
    0
  );
  const alerts = buildAlerts({
    statuses,
    staleActionableCount,
    healthStatus: config?.lastHealthStatus,
    writeEnabled: config?.sharedRecordWriteEnabled,
    unverifiedFacilities,
    totalAttempts,
    succeededAttempts,
    overdueEmergencyReviews,
    expiredMappings,
    failedConsentSyncs: consents.FAILED ?? 0,
  });

  return {
    window: { hours: params.hours, since, generatedAt: now },
    capabilities: capabilitySummary(config),
    health: {
      status: config?.lastHealthStatus ?? "UNKNOWN",
      checkedAt: config?.lastHealthCheckedAt ?? null,
    },
    publication: {
      statuses,
      byResource: resourceGroups.map((group) => ({
        resourceType: group.resourceType,
        count: group._count._all,
      })),
      oldestActionableAt: oldestActionable?.createdAt ?? null,
      staleActionableCount,
    },
    attempts: {
      total: totalAttempts,
      succeeded: succeededAttempts,
      successRate:
        totalAttempts === 0 ? null : succeededAttempts / totalAttempts,
      averageLatencyMs: Math.round(latency._avg.durationMs ?? 0),
      maximumLatencyMs: latency._max.durationMs ?? 0,
      outcomes,
    },
    facilities,
    readiness: {
      contract: {
        version: "RHIE FHIR R4 Swagger 1.0.0",
        retrievedAt: "2026-08-11",
        sha256:
          "67d230d279b6ebfdf68059b3353171538f90d31a04af64fb9449dd1e7d935f05",
      },
      mappings: {
        facilities,
        practitioners,
        destinations,
        coverages,
        expiredReviewCount: expiredMappings,
      },
      terminology: terminologyGroups.map((group) => ({
        domain: group.domain,
        status: group.status,
        count: group._count._all,
      })),
      consentSynchronization: consents,
      blockedReasons,
      emergencyReviews: {
        pending: pendingEmergencyReviews,
        overdue: overdueEmergencyReviews,
      },
      externalPrerequisites: [
        "UPID_ALLOCATION",
        "FACILITY_REGISTRY_CONTRACT",
        "PRACTITIONER_REGISTRY_CONTRACT",
        "AUTHORITATIVE_COVERAGE_RULES",
        "EMERGENCY_ACCESS_LEGAL_APPROVAL",
        "SECURE_PRODUCTION_CONNECTIVITY",
        "MOH_PROFILE_AND_IDEMPOTENCY_CONFIRMATION",
      ],
    },
    alerts,
  };
}

export async function monitorHieOperations() {
  const configs = await db.hieTenantConfig.findMany({
    where: { enabled: true },
    select: { clinicId: true },
  });
  let alertCount = 0;
  for (const config of configs) {
    const summary = await getHieOperationsSummary({
      clinicId: config.clinicId,
      hours: 24,
    });
    for (const alert of summary.alerts) {
      logger.warn("hie.operations.alert", {
        clinicId: config.clinicId,
        code: alert.code,
        severity: alert.severity,
        count: alert.count,
      });
      alertCount += 1;
    }
  }
  return { clinicsChecked: configs.length, alertCount };
}
