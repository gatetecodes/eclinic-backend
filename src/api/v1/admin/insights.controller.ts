import type { Context } from "hono";
import { jsonError, jsonSuccess } from "@/lib/api-response";
import { httpCodes } from "@/lib/constants";
import { FEATURE_MATRIX } from "@/lib/entitlements-matrix";
import redis from "@/services/redis.service";
import {
  AuditSeverity,
  BedStatus,
  CareStage,
  type Prisma,
  Role,
  type SubscriptionPlan,
  SubscriptionStatus,
  UserStatus,
  VisitStatus,
} from "../../../../generated/prisma/client";
import { db } from "../../../database/db";
import { logger } from "../../../lib/logger";
import type { FeatureKey } from "../../../types/access";

const MS_PER_DAY = 86_400_000;

/**
 * How a metric stands relative to its target, or why it has no value.
 *
 * `not_tracked` and `not_enabled` are first-class outcomes rather than zeros: the
 * console must be able to say "we don't measure this" instead of rendering a
 * plausible-looking number that nobody collected. Anything the operator might act
 * on has to be distinguishable from anything we simply don't know.
 */
type MetricStatus =
  | "on_target"
  | "watch"
  | "off_target"
  | "not_tracked"
  | "not_enabled";

type Metric = {
  value: number | null;
  unit: string | null;
  target: string | null;
  status: MetricStatus;
};

/** Classify a lower-is-better metric against its warning and failure thresholds. */
function gauge(
  value: number,
  okAtOrBelow: number,
  watchAtOrBelow: number
): MetricStatus {
  if (value <= okAtOrBelow) {
    return "on_target";
  }
  if (value <= watchAtOrBelow) {
    return "watch";
  }
  return "off_target";
}

const notTracked = (target: string | null = null): Metric => ({
  value: null,
  unit: null,
  target,
  status: "not_tracked",
});

const notEnabled = (target: string): Metric => ({
  value: null,
  unit: null,
  target,
  status: "not_enabled",
});

/** Statuses that mean a clinic is dormant — no live queue, no meaningful metrics. */
const DORMANT_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.SUSPENDED,
  SubscriptionStatus.INACTIVE,
  SubscriptionStatus.ONBOARDING,
];

/**
 * Visit statuses that are no longer in the building. Used to scope "right now"
 * queue counts to genuinely open encounters.
 */
const CLOSED_VISIT_STATUSES: VisitStatus[] = [
  VisitStatus.DISCHARGED,
  VisitStatus.DISCHARGED_WITH_PRESCRIPTION,
  VisitStatus.CANCELLED,
];

const serverError = (c: Context, error: unknown) =>
  jsonError(c, {
    status: httpCodes.INTERNAL_SERVER_ERROR,
    code: "INTERNAL_SERVER_ERROR",
    message: error instanceof Error ? error.message : "Internal Server Error",
  });

function clinicIdParam(c: Context): number | null {
  const id = Number(c.req.param("id"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Which features a clinic actually has live: its plan's matrix row, with any
 * per-clinic override applied on top. Mirrors how entitlements.service resolves
 * them, but in bulk — resolving one clinic at a time would be N round trips for a
 * network-wide adoption chart.
 */
function resolveFeatures(
  plan: keyof typeof FEATURE_MATRIX,
  overrides: { featureKey: string; allowed: boolean | null }[]
): Record<string, boolean> {
  const features: Record<string, boolean> = { ...FEATURE_MATRIX[plan] };
  for (const override of overrides) {
    if (override.allowed !== null) {
      features[override.featureKey] = override.allowed;
    }
  }
  return features;
}

// ---------------------------------------------------------------------------
// system health
// ---------------------------------------------------------------------------

async function probeDatabase(): Promise<{
  value: number | null;
  status: MetricStatus;
}> {
  const start = Date.now();
  try {
    await db.$queryRaw`SELECT 1`;
    const latency = Date.now() - start;
    return { value: latency, status: gauge(latency, 100, 400) };
  } catch (error) {
    logger.error("Health probe: database unreachable", { error });
    return { value: null, status: "off_target" };
  }
}

async function probeRedis(): Promise<{ reachable: boolean }> {
  try {
    const pong = await redis.ping();
    return { reachable: pong === "PONG" };
  } catch (error) {
    logger.error("Health probe: redis unreachable", { error });
    return { reachable: false };
  }
}

/**
 * Best-effort infrastructure health.
 *
 * Reports only what is actually measurable from inside the process: whether Redis
 * answers and how long the DB takes to round-trip. Uptime %, p95 latency, error
 * rate and storage headroom would need an APM/metrics pipeline that does not
 * exist, so they are reported as untracked rather than invented.
 */
async function systemHealth() {
  const [database, cache] = await Promise.all([probeDatabase(), probeRedis()]);

  return {
    database: {
      label: "Database round-trip",
      value: database.value,
      unit: "ms",
      status: database.status,
    },
    cache: {
      label: "Cache (Redis)",
      reachable: cache.reachable,
      status: cache.reachable ? "on_target" : "off_target",
    },
    // Explicitly untracked so the UI states it rather than showing a fake figure.
    apiLatencyP95: notTracked("Requires an APM/metrics pipeline"),
    errorRate: notTracked("Requires an APM/metrics pipeline"),
    storageUsed: notTracked("Requires object-storage metrics"),
    uptime: notTracked("Requires an external uptime monitor"),
    region: process.env.DEPLOY_REGION ?? null,
  };
}

// ---------------------------------------------------------------------------
// platform overview
// ---------------------------------------------------------------------------

/** Why a clinic is on the operator's attention list. */
function attentionReason(status: SubscriptionStatus): string {
  if (status === SubscriptionStatus.SUSPENDED) {
    return "access_blocked";
  }
  if (status === SubscriptionStatus.TRIAL) {
    return "trial_ending";
  }
  return "setup_incomplete";
}

/**
 * Monthly recurring revenue, derived as Σ(plan price × active clinics on it).
 *
 * There is no billing system, so this is a modelled figure rather than money
 * actually collected — but it is derived from real plan prices and a real clinic
 * count, not invented. If the catalogue is empty it reports `not_tracked` instead
 * of 0, since "no prices configured" and "no revenue" are different facts.
 */
function recurringRevenueMetric(
  planPrices: { plan: SubscriptionPlan; monthlyPrice: Prisma.Decimal }[],
  billableByPlan: {
    subscriptionPlan: SubscriptionPlan;
    _count: { id: number };
  }[]
): Metric {
  if (planPrices.length === 0) {
    return notTracked("No plan prices configured");
  }

  const priceByPlan = new Map(
    planPrices.map((row) => [row.plan, Number(row.monthlyPrice)])
  );
  const total = billableByPlan.reduce(
    (sum, row) =>
      sum + (priceByPlan.get(row.subscriptionPlan) ?? 0) * row._count.id,
    0
  );

  return {
    value: total,
    unit: null,
    target: "Modelled from plan prices × active clinics",
    status: "on_target",
  };
}

/** Per-feature adoption across the network, highest first. */
function computeModuleAdoption(
  clinics: { id: number; subscriptionPlan: keyof typeof FEATURE_MATRIX }[],
  overrides: { clinicId: number; featureKey: string; allowed: boolean | null }[]
) {
  const overridesByClinic = new Map<
    number,
    { featureKey: string; allowed: boolean | null }[]
  >();
  for (const override of overrides) {
    const list = overridesByClinic.get(override.clinicId);
    if (list) {
      list.push(override);
    } else {
      overridesByClinic.set(override.clinicId, [override]);
    }
  }

  const featureKeys = Object.keys(
    FEATURE_MATRIX.CLINIC_STARTER
  ) as FeatureKey[];
  const enabledCounts = new Map<string, number>();
  for (const clinic of clinics) {
    const features = resolveFeatures(
      clinic.subscriptionPlan,
      overridesByClinic.get(clinic.id) ?? []
    );
    for (const key of featureKeys) {
      if (features[key]) {
        enabledCounts.set(key, (enabledCounts.get(key) ?? 0) + 1);
      }
    }
  }

  return featureKeys
    .map((key) => {
      const count = enabledCounts.get(key) ?? 0;
      return {
        featureKey: key,
        clinics: count,
        pct:
          clinics.length > 0 ? Math.round((count / clinics.length) * 100) : 0,
      };
    })
    .sort((a, b) => b.pct - a.pct);
}

/**
 * Network-wide operator overview: the headline KPIs, weekly encounter volume,
 * module adoption, the clinics needing attention, recent privileged events and
 * infrastructure health — in one round trip.
 *
 * MRR is intentionally absent: there is no plan pricing in the schema yet, so it
 * arrives with the plan catalogue rather than being guessed at here.
 */
export const getPlatformOverview = async (c: Context) => {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * MS_PER_DAY);

    // Archived clinics are excluded everywhere below: they are soft-deleted and
    // would otherwise drag down adoption percentages and inflate totals.
    const liveClinics: Prisma.ClinicWhereInput = { archivedAt: null };

    const [
      statusGroups,
      staffAccounts,
      patientCount,
      clinicsForAdoption,
      overrides,
      attentionClinics,
      recentEvents,
      criticalEvents,
      dailyVisits,
      health,
      planPrices,
      billableByPlan,
    ] = await Promise.all([
      db.clinic.groupBy({
        by: ["subscriptionStatus"],
        where: liveClinics,
        _count: { id: true },
      }),
      db.user.count({
        where: { status: UserStatus.ACTIVE, role: { not: Role.PATIENT } },
      }),
      db.patient.count(),
      db.clinic.findMany({
        where: liveClinics,
        select: { id: true, subscriptionPlan: true },
      }),
      db.entitlementOverride.findMany({
        select: { clinicId: true, featureKey: true, allowed: true },
      }),
      db.clinic.findMany({
        where: {
          ...liveClinics,
          subscriptionStatus: {
            in: [
              SubscriptionStatus.SUSPENDED,
              SubscriptionStatus.TRIAL,
              SubscriptionStatus.ONBOARDING,
            ],
          },
        },
        orderBy: { updatedAt: "desc" },
        take: 12,
        select: {
          id: true,
          name: true,
          subscriptionStatus: true,
          subscriptionPlan: true,
          subscriptionExpiryDate: true,
        },
      }),
      db.adminAuditLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          action: true,
          category: true,
          severity: true,
          actorName: true,
          targetType: true,
          targetId: true,
          createdAt: true,
          actor: { select: { name: true } },
        },
      }),
      // Backs the Audit-log badge on the operator sidebar. Scoped to the last 7
      // days so it reads as "needs looking at now" rather than a lifetime total
      // that would never return to zero.
      db.adminAuditLog.count({
        where: {
          severity: AuditSeverity.CRITICAL,
          createdAt: { gte: sevenDaysAgo },
        },
      }),
      // Grouped in SQL rather than fetching 7 days of visit rows to count them.
      db.$queryRaw<{ day: Date; count: bigint }[]>`
        SELECT DATE_TRUNC('day', "createdAt") AS day, COUNT(*) AS count
        FROM "Visit"
        WHERE "createdAt" >= ${sevenDaysAgo}
        GROUP BY day
        ORDER BY day ASC
      `,
      systemHealth(),
      // Plan prices, for the derived MRR below.
      db.plan.findMany({ select: { plan: true, monthlyPrice: true } }),
      // Only ACTIVE clinics are billable, so MRR counts nothing else.
      db.clinic.groupBy({
        by: ["subscriptionPlan"],
        where: {
          ...liveClinics,
          subscriptionStatus: SubscriptionStatus.ACTIVE,
        },
        _count: { id: true },
      }),
    ]);

    const countFor = (status: SubscriptionStatus) =>
      statusGroups.find((row) => row.subscriptionStatus === status)?._count
        .id ?? 0;
    // Sum the groups rather than adding named statuses: that arithmetic silently
    // undercounts every time a new SubscriptionStatus is introduced.
    const totalClinics = statusGroups.reduce(
      (sum, row) => sum + row._count.id,
      0
    );

    // Fill every one of the last 7 days so the chart has no gaps where a quiet
    // day would otherwise be missing entirely.
    const visitsByDay = new Map(
      dailyVisits.map((row) => [
        row.day.toISOString().slice(0, 10),
        Number(row.count),
      ])
    );
    const networkActivity = Array.from({ length: 7 }, (_, index) => {
      const day = new Date(now.getTime() - (6 - index) * MS_PER_DAY);
      const key = day.toISOString().slice(0, 10);
      return { date: key, visits: visitsByDay.get(key) ?? 0 };
    });

    return jsonSuccess(c, {
      data: {
        kpis: {
          activeClinics: {
            value: countFor(SubscriptionStatus.ACTIVE),
            total: totalClinics,
          },
          staffAccounts: { value: staffAccounts },
          patients: { value: patientCount },
          recurringRevenue: recurringRevenueMetric(planPrices, billableByPlan),
        },
        breakdown: {
          active: countFor(SubscriptionStatus.ACTIVE),
          trial: countFor(SubscriptionStatus.TRIAL),
          onboarding: countFor(SubscriptionStatus.ONBOARDING),
          suspended: countFor(SubscriptionStatus.SUSPENDED),
          archivedExcluded: true,
        },
        networkActivity,
        moduleAdoption: computeModuleAdoption(clinicsForAdoption, overrides),
        attention: attentionClinics.map((clinic) => ({
          id: clinic.id,
          name: clinic.name,
          status: clinic.subscriptionStatus,
          plan: clinic.subscriptionPlan,
          expiresAt: clinic.subscriptionExpiryDate,
          reason: attentionReason(clinic.subscriptionStatus),
        })),
        recentEvents: recentEvents.map((event) => ({
          ...event,
          actorName: event.actorName ?? event.actor?.name ?? null,
        })),
        criticalEvents,
        health,
      },
    });
  } catch (error) {
    return serverError(c, error);
  }
};

// ---------------------------------------------------------------------------
// clinical snapshot
// ---------------------------------------------------------------------------

function bedOccupancyMetric(
  enabled: boolean,
  occupied: number,
  total: number
): Metric {
  if (!enabled) {
    return notEnabled("Inpatient module not enabled");
  }
  if (total === 0) {
    return {
      value: null,
      unit: "%",
      target: "No beds configured",
      status: "not_tracked",
    };
  }
  const pct = Math.round((occupied / total) * 100);
  return {
    value: pct,
    unit: "%",
    target: `Target under 85% · ${total} beds`,
    status: gauge(pct, 85, 92),
  };
}

function averageWaitMetric(avgMinutes: number | null): Metric {
  if (avgMinutes === null) {
    return notTracked("No completed queue entries in the last 30 days");
  }
  return {
    value: Math.round(avgMinutes),
    unit: "min",
    target: "Target under 25 min",
    status: gauge(avgMinutes, 25, 35),
  };
}

function labTurnaroundMetric(
  enabled: boolean,
  p90Hours: number | null
): Metric {
  if (!enabled) {
    return notEnabled("Laboratory module not enabled");
  }
  if (p90Hours === null) {
    return notTracked("No lab results in the last 30 days");
  }
  return {
    value: Math.round(p90Hours * 10) / 10,
    unit: "hrs",
    target: "Target under 6 hrs (p90)",
    status: gauge(p90Hours, 6, 9),
  };
}

function stockOutMetric(enabled: boolean, count: number): Metric {
  if (!enabled) {
    return notEnabled("Pharmacy module not enabled");
  }
  return {
    value: count,
    unit: "items",
    target: "Items at or below reorder level",
    status: gauge(count, 2, 4),
  };
}

/** The live pipeline, in the order the design lays the stages out. */
function buildPatientFlow(
  stageCounts: Map<CareStage, number>,
  inpatientEnabled: boolean,
  occupiedBeds: number
) {
  const stages: CareStage[] = [
    CareStage.RECEPTION,
    CareStage.TRIAGE,
    CareStage.DOCTOR,
    CareStage.LAB,
    CareStage.PHARMACY,
    CareStage.BILLING,
  ];
  const flow: {
    stage: string;
    count: number | null;
    status?: MetricStatus;
  }[] = stages.map((stage) => ({
    stage,
    count: stageCounts.get(stage) ?? 0,
  }));

  flow.push({
    stage: "ADMITTED",
    count: inpatientEnabled ? occupiedBeds : null,
    status: inpatientEnabled ? undefined : "not_enabled",
  });
  return flow;
}

/**
 * Clinical snapshot for one tenant: who is in the building right now, the four
 * care-quality metrics, and 30-day/6-month workload shape.
 *
 * Every metric carries its own status so the UI never has to decide what "good"
 * means, and metrics belonging to a module the clinic has not bought return
 * `not_enabled` rather than 0.
 */
export const getClinicClinical = async (c: Context) => {
  try {
    const clinicId = clinicIdParam(c);
    if (!clinicId) {
      return jsonError(c, {
        status: httpCodes.BAD_REQUEST,
        code: "BAD_REQUEST",
        messageKey: "common.invalidId",
      });
    }

    const clinic = await db.clinic.findUnique({
      where: { id: clinicId },
      select: { id: true, subscriptionPlan: true, subscriptionStatus: true },
    });
    if (!clinic) {
      return jsonError(c, {
        status: httpCodes.NOT_FOUND,
        code: "NOT_FOUND",
        message: "Clinic not found",
      });
    }

    const overrides = await db.entitlementOverride.findMany({
      where: { clinicId },
      select: { featureKey: true, allowed: true },
    });
    const features = resolveFeatures(clinic.subscriptionPlan, overrides);
    const inpatientEnabled = features.hospitalization === true;
    const labEnabled = features.lab === true;
    const pharmacyEnabled = features.pharmacy === true;
    const dormant = DORMANT_STATUSES.includes(clinic.subscriptionStatus);

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * MS_PER_DAY);

    const [
      stageGroups,
      beds,
      queueTimings,
      labTimings,
      stockOuts,
      departmentGroups,
      diagnoses,
      monthlyVisits,
    ] = await Promise.all([
      // "Right now": open encounters only, grouped by pipeline stage.
      dormant
        ? Promise.resolve([])
        : db.visit.groupBy({
            by: ["careStage"],
            where: {
              clinicId,
              careStage: { not: CareStage.DONE },
              status: { notIn: CLOSED_VISIT_STATUSES },
            },
            _count: { id: true },
          }),
      inpatientEnabled
        ? db.bed.groupBy({
            by: ["status"],
            where: { ward: { clinicId } },
            _count: { id: true },
          })
        : Promise.resolve([]),
      // Average minutes from joining a queue to being served, last 30 days.
      dormant
        ? Promise.resolve<{ avg_minutes: number | null }[]>([])
        : db.$queryRaw<{ avg_minutes: number | null }[]>`
            SELECT AVG(EXTRACT(EPOCH FROM (qe."servedAt" - qe."joinedAt")) / 60) AS avg_minutes
            FROM "QueueEntry" qe
            JOIN "Queue" q ON q.id = qe."queueId"
            WHERE q."clinicId" = ${clinicId}
              AND qe."joinedAt" IS NOT NULL
              AND qe."servedAt" IS NOT NULL
              AND qe."servedAt" >= ${thirtyDaysAgo}
          `,
      // p90 lab turnaround: exam ordered → result recorded.
      labEnabled
        ? db.$queryRaw<{ p90_hours: number | null }[]>`
            SELECT PERCENTILE_CONT(0.9) WITHIN GROUP (
                     ORDER BY EXTRACT(EPOCH FROM (r."createdAt" - e."createdAt")) / 3600
                   ) AS p90_hours
            FROM "ExamResult" r
            JOIN "Exam" e ON e.id = r."examId"
            WHERE r."clinicId" = ${clinicId}
              AND r."createdAt" >= ${thirtyDaysAgo}
              AND r."createdAt" > e."createdAt"
          `
        : Promise.resolve<{ p90_hours: number | null }[]>([]),
      pharmacyEnabled
        ? db.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(*) AS count
            FROM "InventoryStock" s
            JOIN "InventoryItem" i ON i.id = s."itemId"
            WHERE i."clinicId" = ${clinicId}
              AND s.quantity <= i."reorderLevel"
          `
        : Promise.resolve<{ count: bigint }[]>([]),
      db.visit.groupBy({
        by: ["departmentId"],
        where: { clinicId, createdAt: { gte: thirtyDaysAgo } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 8,
      }),
      db.visitDiagnosis.groupBy({
        by: ["description"],
        where: { visit: { clinicId }, createdAt: { gte: thirtyDaysAgo } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 6,
      }),
      db.$queryRaw<{ month: Date; count: bigint }[]>`
        SELECT DATE_TRUNC('month', "createdAt") AS month, COUNT(*) AS count
        FROM "Visit"
        WHERE "clinicId" = ${clinicId}
          AND "createdAt" >= DATE_TRUNC('month', NOW()) - INTERVAL '5 months'
        GROUP BY month
        ORDER BY month ASC
      `,
    ]);

    const stageCounts = new Map(
      stageGroups.map((row) => [row.careStage, row._count.id])
    );
    const occupiedBeds =
      beds.find((row) => row.status === BedStatus.OCCUPIED)?._count.id ?? 0;
    const totalBeds = beds.reduce((sum, row) => sum + row._count.id, 0);

    // Resolve department names in one lookup rather than per group row.
    const departmentIds = departmentGroups
      .map((row) => row.departmentId)
      .filter((id): id is number => id !== null);
    const departmentNames = new Map(
      (
        await db.clinicalDepartment.findMany({
          where: { id: { in: departmentIds } },
          select: { id: true, name: true },
        })
      ).map((dept) => [dept.id, dept.name])
    );

    return jsonSuccess(c, {
      data: {
        dormant,
        modules: {
          inpatient: inpatientEnabled,
          lab: labEnabled,
          pharmacy: pharmacyEnabled,
        },
        patientFlow: buildPatientFlow(
          stageCounts,
          inpatientEnabled,
          occupiedBeds
        ),
        careMetrics: {
          bedOccupancy: bedOccupancyMetric(
            inpatientEnabled,
            occupiedBeds,
            totalBeds
          ),
          averageWait: averageWaitMetric(queueTimings[0]?.avg_minutes ?? null),
          labTurnaround: labTurnaroundMetric(
            labEnabled,
            labTimings[0]?.p90_hours ?? null
          ),
          pharmacyStockOuts: stockOutMetric(
            pharmacyEnabled,
            Number(stockOuts[0]?.count ?? 0)
          ),
        },
        departments: departmentGroups.map((row) => ({
          departmentId: row.departmentId,
          name:
            row.departmentId === null
              ? null
              : (departmentNames.get(row.departmentId) ?? null),
          encounters: row._count.id,
        })),
        diagnoses: diagnoses.map((row, index) => ({
          rank: index + 1,
          description: row.description,
          count: row._count.id,
        })),
        monthlyVolume: monthlyVisits.map((row) => ({
          month: row.month.toISOString().slice(0, 7),
          visits: Number(row.count),
        })),
      },
    });
  } catch (error) {
    return serverError(c, error);
  }
};

// ---------------------------------------------------------------------------
// compliance
// ---------------------------------------------------------------------------

/** Overall access posture, driven by 2FA coverage and whether access is blocked. */
function accessPosture(
  twoFactorPct: number | null,
  status: SubscriptionStatus
): string {
  if (twoFactorPct === null) {
    return "not_tracked";
  }
  if (twoFactorPct === 100 && status !== SubscriptionStatus.SUSPENDED) {
    return "compliant";
  }
  if (twoFactorPct >= 70) {
    return "needs_attention";
  }
  return "at_risk";
}

function twoFactorMetric(enrolled: number, total: number): Metric {
  if (total === 0) {
    return notTracked("No staff accounts");
  }
  const pct = Math.round((enrolled / total) * 100);
  return {
    value: pct,
    unit: "%",
    target: `${enrolled} of ${total} accounts enrolled`,
    status: pct === 100 ? "on_target" : "watch",
  };
}

/**
 * Compliance posture for one tenant.
 *
 * Split deliberately into what the product actually records (2FA enrolment, bulk
 * exports from the audit trail) and what it does not (patient consent rates,
 * encryption attestation, access reviews, facility licences). The untracked items
 * are returned explicitly so the UI states their absence — a fabricated "98.4%
 * consent" figure in a medical system would be worse than an empty panel.
 */
export const getClinicCompliance = async (c: Context) => {
  try {
    const clinicId = clinicIdParam(c);
    if (!clinicId) {
      return jsonError(c, {
        status: httpCodes.BAD_REQUEST,
        code: "BAD_REQUEST",
        messageKey: "common.invalidId",
      });
    }

    const clinic = await db.clinic.findUnique({
      where: { id: clinicId },
      select: { id: true, subscriptionStatus: true },
    });
    if (!clinic) {
      return jsonError(c, {
        status: httpCodes.NOT_FOUND,
        code: "NOT_FOUND",
        message: "Clinic not found",
      });
    }

    const [staff, bulkExports] = await Promise.all([
      db.user.findMany({
        where: {
          clinicId,
          role: { not: Role.PATIENT },
          status: { in: [UserStatus.ACTIVE, UserStatus.INVITED] },
        },
        select: {
          id: true,
          name: true,
          role: true,
          isTwoFactorEnabled: true,
          status: true,
        },
        orderBy: { name: "asc" },
      }),
      db.adminAuditLog.count({
        where: {
          targetType: "clinic",
          targetId: clinicId,
          category: "ACCESS",
          severity: "CRITICAL",
        },
      }),
    ]);

    const enrolled = staff.filter((member) => member.isTwoFactorEnabled);
    const twoFactor = twoFactorMetric(enrolled.length, staff.length);

    return jsonSuccess(c, {
      data: {
        posture: accessPosture(twoFactor.value, clinic.subscriptionStatus),
        checks: {
          twoFactor,
          bulkExports: {
            value: bulkExports,
            unit: null,
            target: "Privileged exports recorded against this clinic",
            status: bulkExports > 0 ? "watch" : "on_target",
          },
          // Not recorded anywhere in the product. Stated, not guessed.
          patientConsent: notTracked(
            "Consent capture is not recorded per patient"
          ),
          encryptionAtRest: notTracked(
            "No attestation is stored for the storage layer"
          ),
          lastAccessReview: notTracked("Access reviews are not tracked"),
        },
        // A ClinicLicence model does not exist; the section renders as untracked
        // rather than showing invented licence numbers and expiry dates.
        licences: { status: "not_tracked", items: [] },
        staffMissingTwoFactor: staff
          .filter((member) => !member.isTwoFactorEnabled)
          .map((member) => ({
            id: member.id,
            name: member.name,
            role: member.role,
            status: member.status,
          })),
      },
    });
  } catch (error) {
    return serverError(c, error);
  }
};
