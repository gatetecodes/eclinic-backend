import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { jsonError, jsonSuccess } from "@/lib/api-response";
import { httpCodes } from "@/lib/constants";
import { type AuditAction, writeAudit } from "@/services/audit.service";
import {
  getCachedEntitlements,
  invalidateEntitlements,
} from "@/services/entitlements.service";
import {
  type Prisma,
  SubscriptionStatus,
  type User,
} from "../../../../generated/prisma/client";
import { db } from "../../../database/db";
import { buildQueryOptions } from "../../../helpers/query-helper";
import { searchParamsSchema } from "../../../lib/common-validation";
import type { FeatureKey } from "../../../types/access";

export const getStats = async (c: Context) => {
  try {
    const [totalClinics, totalUsers, totalPatients, totalVisits, totalRevenue] =
      await Promise.all([
        db.clinic.count(),
        db.user.count(),
        db.patient.count(),
        db.visit.count(),
        db.payment.aggregate({ _sum: { amount: true } }),
      ]);

    return c.json({
      data: {
        totalClinics,
        totalUsers,
        totalPatients,
        totalVisits,
        totalRevenue: totalRevenue._sum.amount || 0,
      },
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

const deltaPct = (current: number, previous: number): number => {
  if (previous === 0) {
    return current > 0 ? 100 : 0;
  }
  return Number((((current - previous) / previous) * 100).toFixed(1));
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Cap the number of clinics whose entitlements we resolve for the quota-breach
// scan so the dashboard endpoint stays bounded regardless of tenant count.
const QUOTA_SCAN_CLINIC_CAP = 100;

/**
 * Batched platform-operator dashboard. One round trip backing the /admin home:
 * headline KPIs plus the operator's action queues (pending demos, expiring
 * subscriptions, quota breaches). Uses only data that exists today — no MRR or
 * SaaS-invoice queues (those arrive with the billing models in a later phase).
 */
export const getAdminDashboard = async (c: Context) => {
  try {
    const now = new Date();
    const in14Days = new Date(now.getTime() + 14 * MS_PER_DAY);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * MS_PER_DAY);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * MS_PER_DAY);
    const period = now.toISOString().slice(0, 7);

    const [
      statusCounts,
      activeUsers,
      revenueAgg,
      newReg30,
      newRegPrev30,
      pendingDemos,
      expiringSubs,
      usageRows,
    ] = await Promise.all([
      db.clinic.groupBy({ by: ["subscriptionStatus"], _count: { id: true } }),
      db.user.count({ where: { status: "ACTIVE" } }),
      db.payment.aggregate({ _sum: { amount: true } }),
      db.clinic.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      db.clinic.count({
        where: { createdAt: { gte: sixtyDaysAgo, lt: thirtyDaysAgo } },
      }),
      db.demoRequest.findMany({
        where: { status: "PENDING" },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, clinic_name: true, createdAt: true },
      }),
      db.clinic.findMany({
        where: {
          subscriptionExpiryDate: { gte: now, lte: in14Days },
          subscriptionStatus: { in: ["ACTIVE", "TRIAL"] },
        },
        orderBy: { subscriptionExpiryDate: "asc" },
        take: 10,
        select: {
          id: true,
          name: true,
          subscriptionPlan: true,
          subscriptionExpiryDate: true,
        },
      }),
      db.entitlementUsage.findMany({
        where: { period },
        select: { clinicId: true, featureKey: true, count: true },
      }),
    ]);

    const countFor = (status: SubscriptionStatus) =>
      statusCounts.find((s) => s.subscriptionStatus === status)?._count.id ?? 0;
    const activeTenants = countFor(SubscriptionStatus.ACTIVE);
    const trials = countFor(SubscriptionStatus.TRIAL);
    // Sum the groups instead of adding named statuses: the previous
    // ACTIVE+TRIAL+INACTIVE arithmetic silently dropped every clinic in a status
    // it didn't enumerate, and now undercounts SUSPENDED and ONBOARDING.
    const totalClinics = statusCounts.reduce(
      (sum, row) => sum + row._count.id,
      0
    );
    const conversionRate =
      activeTenants + trials > 0
        ? Number(((activeTenants / (activeTenants + trials)) * 100).toFixed(1))
        : 0;

    // Quota breaches: compare this period's usage against each clinic's
    // computed limit. Resolve entitlements per distinct clinic (cached),
    // capped so the scan stays bounded.
    const distinctClinicIds = [
      ...new Set(usageRows.map((r) => r.clinicId)),
    ].slice(0, QUOTA_SCAN_CLINIC_CAP);
    const entitlementsByClinic = new Map(
      await Promise.all(
        distinctClinicIds.map(
          async (id) => [id, await getCachedEntitlements(id)] as const
        )
      )
    );
    const rawBreaches = usageRows.flatMap((row) => {
      const limit = entitlementsByClinic.get(row.clinicId)?.limits?.[
        row.featureKey as FeatureKey
      ];
      if (typeof limit === "number" && limit > 0 && row.count >= limit) {
        return [
          {
            clinicId: row.clinicId,
            featureKey: row.featureKey,
            used: row.count,
            limit,
          },
        ];
      }
      return [];
    });
    const breachClinicNames = new Map(
      (
        await db.clinic.findMany({
          where: {
            id: { in: [...new Set(rawBreaches.map((b) => b.clinicId))] },
          },
          select: { id: true, name: true },
        })
      ).map((clinic) => [clinic.id, clinic.name])
    );
    const quotaBreaches = rawBreaches.slice(0, 20).map((b) => ({
      ...b,
      name: breachClinicNames.get(b.clinicId) ?? `Clinic #${b.clinicId}`,
    }));

    return jsonSuccess(c, {
      data: {
        kpis: {
          activeTenants: { value: activeTenants },
          trials: { value: trials },
          totalClinics: { value: totalClinics },
          activeUsers: { value: activeUsers },
          newRegistrations: {
            value: newReg30,
            deltaPct: deltaPct(newReg30, newRegPrev30),
          },
          totalRevenue: { value: Number(revenueAgg._sum.amount ?? 0) },
          conversionRate: { value: conversionRate },
        },
        queues: {
          pendingDemos: pendingDemos.map((d) => ({
            id: d.id,
            clinicName: d.clinic_name,
            requestedAt: d.createdAt,
          })),
          expiringSubs: expiringSubs.map((s) => ({
            clinicId: s.id,
            name: s.name,
            plan: s.subscriptionPlan,
            expiryDate: s.subscriptionExpiryDate,
          })),
          quotaBreaches,
        },
      },
    });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getClinicEntitlements = async (c: Context) => {
  try {
    const clinicId = Number(c.req.param("id"));
    if (!Number.isFinite(clinicId)) {
      return c.json(
        { error: "Bad clinic id" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const entitlements = await getCachedEntitlements(clinicId);
    return c.json({ data: entitlements }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getClinicEntitlementOverrides = async (c: Context) => {
  try {
    const clinicId = Number(c.req.param("id"));
    if (!Number.isFinite(clinicId)) {
      return c.json({ error: "Bad clinic id" }, 400);
    }
    const overrides = await db.entitlementOverride.findMany({
      where: { clinicId },
    });
    return c.json({ data: overrides }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const upsertClinicEntitlementOverrides = async (c: Context) => {
  try {
    const clinicId = Number(c.req.param("id"));
    if (!Number.isFinite(clinicId)) {
      return c.json(
        { error: "Bad clinic id" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const body = c.get("validatedJson");
    const { overrides } = body;

    await db.$transaction(async (tx) => {
      await Promise.all(
        overrides.map(
          async (ov: {
            featureKey: string;
            allowed?: boolean;
            limit?: number;
            notes?: string;
          }) =>
            await tx.entitlementOverride.upsert({
              where: {
                clinicId_featureKey: { clinicId, featureKey: ov.featureKey },
              },
              update: { allowed: ov.allowed, limit: ov.limit, notes: ov.notes },
              create: {
                clinicId,
                featureKey: ov.featureKey,
                allowed: ov.allowed,
                limit: ov.limit,
                notes: ov.notes,
              },
            })
        )
      );
    });

    await invalidateEntitlements(clinicId);
    await writeAudit(c, "entitlement.overridesUpdated", {
      targetType: "clinic",
      targetId: clinicId,
      metadata: {
        featureKeys: overrides.map((o: { featureKey: string }) => o.featureKey),
      },
    });
    return c.json(
      { success: true, message: "Entitlement overrides updated successfully" },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

/**
 * Global feature-usage for the current month, paginated + filterable, with the
 * clinic name joined in. Filters: `featureKey` (exact) and `clinic` (name
 * search). Ordered by heaviest usage first.
 */
export const getEntitlementUsageSummary = async (c: Context) => {
  try {
    const period = new Date().toISOString().slice(0, 7);
    const page = Math.max(1, Number(c.req.query("page")) || 1);
    const perPage = Math.min(
      100,
      Math.max(1, Number(c.req.query("per_page")) || 20)
    );

    const where: Prisma.EntitlementUsageWhereInput = { period };
    const featureKey = c.req.query("featureKey");
    if (featureKey) {
      where.featureKey = featureKey;
    }
    const clinicSearch = c.req.query("clinicName");
    if (clinicSearch) {
      where.clinic = {
        name: { contains: clinicSearch, mode: "insensitive" },
      };
    }

    const [rows, totalCount] = await Promise.all([
      db.entitlementUsage.findMany({
        where,
        orderBy: { count: "desc" },
        skip: (page - 1) * perPage,
        take: perPage,
        select: {
          clinicId: true,
          featureKey: true,
          count: true,
          period: true,
          clinic: { select: { name: true } },
        },
      }),
      db.entitlementUsage.count({ where }),
    ]);

    const data = rows.map((r) => ({
      clinicId: r.clinicId,
      clinicName: r.clinic?.name ?? `Clinic #${r.clinicId}`,
      featureKey: r.featureKey,
      count: r.count,
      period: r.period,
    }));

    return jsonSuccess(c, {
      data,
      meta: { totalCount, pageCount: Math.ceil(totalCount / perPage) },
    });
  } catch (error) {
    return jsonError(c, {
      status: httpCodes.INTERNAL_SERVER_ERROR,
      code: "INTERNAL_SERVER_ERROR",
      message: error instanceof Error ? error.message : "Internal Server Error",
    });
  }
};

// ---------------------------------------------------------------------------
// Phase 2: tenant management (lifecycle, cross-tenant users, audit)
// ---------------------------------------------------------------------------

/**
 * Read a numeric query param, or undefined when it is absent or not a number.
 *
 * `Number(c.req.query(k))` is not enough: an empty param (`?clinicId=`) coerces to
 * 0, which `Number.isFinite` accepts, silently turning "no filter" into
 * "clinicId 0" and returning an empty result set.
 */
function numericQuery(c: Context, key: string): number | undefined {
  const raw = c.req.query(key);
  if (raw === undefined || raw.trim() === "") {
    return;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const USER_ADMIN_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  phone_number: true,
  clinicId: true,
  createdAt: true,
  clinic: { select: { id: true, name: true } },
} satisfies Prisma.UserSelect;

/**
 * Lifecycle action → audit action. Mapped explicitly rather than interpolated so
 * the audit action stays a member of the AuditAction union (and so an unhandled
 * lifecycle action is a compile error, not a silently unlogged transition).
 */
const LIFECYCLE_AUDIT_ACTIONS = {
  suspend: "clinic.suspend",
  reactivate: "clinic.reactivate",
  archive: "clinic.archive",
} as const satisfies Record<string, AuditAction>;

/**
 * Clinic lifecycle transitions for the operator. Each action maps to a distinct
 * subscriptionStatus so the console can tell them apart: suspend blocks access
 * while preserving data, archive is a soft-delete (INACTIVE + archivedAt). Every
 * transition invalidates the entitlement cache and is audited with the operator's
 * stated reason.
 */
export const updateClinicLifecycle = async (c: Context) => {
  try {
    const clinicId = Number(c.req.param("id"));
    if (!Number.isFinite(clinicId)) {
      return jsonError(c, {
        status: httpCodes.BAD_REQUEST,
        code: "BAD_REQUEST",
        messageKey: "common.invalidId",
      });
    }
    const { action, reason } = c.get("validatedJson") as {
      action: "suspend" | "reactivate" | "archive";
      reason: string;
    };

    let data: Prisma.ClinicUpdateInput;
    switch (action) {
      case "suspend":
        data = { subscriptionStatus: SubscriptionStatus.SUSPENDED };
        break;
      case "reactivate":
        data = {
          subscriptionStatus: SubscriptionStatus.ACTIVE,
          archivedAt: null,
        };
        break;
      default:
        data = {
          subscriptionStatus: SubscriptionStatus.INACTIVE,
          archivedAt: new Date(),
        };
        break;
    }

    const updated = await db.clinic.update({
      where: { id: clinicId },
      data,
    });

    await invalidateEntitlements(clinicId);
    await writeAudit(c, LIFECYCLE_AUDIT_ACTIONS[action], {
      targetType: "clinic",
      targetId: clinicId,
      metadata: { reason },
    });

    return jsonSuccess(c, { data: updated });
  } catch (error) {
    return jsonError(c, {
      status: httpCodes.INTERNAL_SERVER_ERROR,
      code: "INTERNAL_SERVER_ERROR",
      message: error instanceof Error ? error.message : "Internal Server Error",
    });
  }
};

/**
 * Cross-tenant user directory for the operator.
 *
 * `lastSeenAt` is derived from the newest Session row per user rather than stored
 * on User: there is no last-login column, and Session.updatedAt is already
 * refreshed on activity by better-auth's `updateAge`, so it is the honest signal
 * available without a migration. Users who have never held a session get null,
 * which the UI shows as "never" — not as a recent timestamp.
 */
export const getAllUsers = async (c: Context) => {
  try {
    const params = searchParamsSchema.parse(c.req.query());
    const additionalWhere: Prisma.UserWhereInput = {};

    const roleParam = c.req.query("role");
    if (roleParam) {
      additionalWhere.role = roleParam as Prisma.UserWhereInput["role"];
    }
    const statusParam = c.req.query("status");
    if (statusParam) {
      additionalWhere.status = statusParam as Prisma.UserWhereInput["status"];
    }
    const clinicIdParam = numericQuery(c, "clinicId");
    if (clinicIdParam !== undefined) {
      additionalWhere.clinicId = clinicIdParam;
    }

    // One search box spanning name, email and the owning clinic's name, matching
    // the console's single "Search clinics, users, events…" affordance.
    //
    // The term is taken from `name` (the shared searchable-column convention the
    // frontend tables use) but is deliberately NOT forwarded to
    // buildQueryOptions: that helper builds its own top-level `OR` for `name`,
    // which would collide with the one below and silently drop one of the two.
    // Nesting ours under `AND` keeps both composable.
    const { name: searchTerm, ...paramsWithoutName } = params;
    const search = searchTerm?.trim();
    if (search) {
      additionalWhere.AND = [
        {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
            { clinic: { name: { contains: search, mode: "insensitive" } } },
          ],
        },
      ];
    }

    const { where, orderBy, ...rest } = buildQueryOptions<User>(
      paramsWithoutName,
      additionalWhere as Record<string, unknown>
    );

    const [users, totalCount] = await Promise.all([
      db.user.findMany({
        where: where as Prisma.UserWhereInput,
        orderBy: orderBy as Prisma.UserOrderByWithRelationInput,
        ...rest,
        select: USER_ADMIN_SELECT,
      }),
      db.user.count({ where: where as Prisma.UserWhereInput }),
    ]);

    // One grouped query for the whole page rather than a per-row lookup.
    const lastSeenByUser = new Map<number, Date>();
    if (users.length > 0) {
      const sessions = await db.session.groupBy({
        by: ["userId"],
        where: { userId: { in: users.map((u) => u.id) } },
        _max: { updatedAt: true },
      });
      for (const row of sessions) {
        if (row._max.updatedAt) {
          lastSeenByUser.set(row.userId, row._max.updatedAt);
        }
      }
    }

    const pageCount = rest.take ? Math.ceil(totalCount / rest.take) : 0;
    return jsonSuccess(c, {
      data: users.map((user) => ({
        ...user,
        lastSeenAt: lastSeenByUser.get(user.id) ?? null,
      })),
      meta: { totalCount, pageCount },
    });
  } catch (error) {
    return jsonError(c, {
      status: httpCodes.INTERNAL_SERVER_ERROR,
      code: "INTERNAL_SERVER_ERROR",
      message: error instanceof Error ? error.message : "Internal Server Error",
    });
  }
};

/** Staff of a single tenant, for the operator's clinic drill-down. */
export const getClinicUsersForAdmin = async (c: Context) => {
  try {
    const clinicId = Number(c.req.param("id"));
    if (!Number.isFinite(clinicId)) {
      return jsonError(c, {
        status: httpCodes.BAD_REQUEST,
        code: "BAD_REQUEST",
        messageKey: "common.invalidId",
      });
    }
    const users = await db.user.findMany({
      where: { clinicId },
      orderBy: { createdAt: "desc" },
      select: USER_ADMIN_SELECT,
    });
    return jsonSuccess(c, { data: users });
  } catch (error) {
    return jsonError(c, {
      status: httpCodes.INTERNAL_SERVER_ERROR,
      code: "INTERNAL_SERVER_ERROR",
      message: error instanceof Error ? error.message : "Internal Server Error",
    });
  }
};

/**
 * Build the audit-log where clause from query params. Shared by the paginated
 * read and the CSV export so an export can never cover a different set of rows
 * than the view it was triggered from.
 */
function auditWhereFromQuery(c: Context): Prisma.AdminAuditLogWhereInput {
  const where: Prisma.AdminAuditLogWhereInput = {};

  const actorId = numericQuery(c, "actorId");
  if (actorId !== undefined) {
    where.actorId = actorId;
  }
  const actionParam = c.req.query("action");
  if (actionParam) {
    where.action = actionParam;
  }
  const category = c.req.query("category");
  if (category) {
    where.category = category as Prisma.AdminAuditLogWhereInput["category"];
  }
  const severity = c.req.query("severity");
  if (severity) {
    where.severity = severity as Prisma.AdminAuditLogWhereInput["severity"];
  }
  const clinicId = numericQuery(c, "clinicId");
  if (clinicId !== undefined) {
    where.targetType = "clinic";
    where.targetId = clinicId;
  }

  return where;
}

const AUDIT_ACTOR_SELECT = {
  actor: { select: { id: true, name: true, email: true } },
} satisfies Prisma.AdminAuditLogInclude;

/**
 * Operator audit trail. Filters: actorId, action, category, severity, and
 * clinicId (mapped to the polymorphic targetType="clinic"/targetId). Paginated,
 * newest first.
 *
 * `meta.counts` carries per-category totals for the filter chips, computed with
 * every filter *except* category applied — so each chip shows how many rows
 * selecting it would yield. Returned in the same response to keep the chip row
 * from costing five extra round trips.
 */
export const getAuditLogs = async (c: Context) => {
  try {
    const page = Math.max(1, Number(c.req.query("page")) || 1);
    const perPage = Math.min(
      100,
      Math.max(1, Number(c.req.query("per_page")) || 20)
    );

    const where = auditWhereFromQuery(c);
    const { category: _omitted, ...whereWithoutCategory } = where;

    const [logs, totalCount, groupedCounts] = await Promise.all([
      db.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * perPage,
        take: perPage,
        include: AUDIT_ACTOR_SELECT,
      }),
      db.adminAuditLog.count({ where }),
      db.adminAuditLog.groupBy({
        by: ["category"],
        where: whereWithoutCategory,
        _count: { _all: true },
      }),
    ]);

    const counts: Record<string, number> = {};
    let allCount = 0;
    for (const row of groupedCounts) {
      counts[row.category] = row._count._all;
      allCount += row._count._all;
    }

    return jsonSuccess(c, {
      data: logs,
      meta: {
        totalCount,
        pageCount: Math.ceil(totalCount / perPage),
        counts: { all: allCount, ...counts },
      },
    });
  } catch (error) {
    return jsonError(c, {
      status: httpCodes.INTERNAL_SERVER_ERROR,
      code: "INTERNAL_SERVER_ERROR",
      message: error instanceof Error ? error.message : "Internal Server Error",
    });
  }
};

/** Escape one CSV field: quote it and double any embedded quotes. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  let text: string;
  if (value instanceof Date) {
    text = value.toISOString();
  } else if (typeof value === "object") {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Hard ceiling on an export. The audit log grows without bound, so exporting
 * "everything" would eventually mean holding millions of rows in memory; the
 * operator narrows with filters instead. The audit entry records when a file was
 * truncated rather than letting a partial export pass as complete.
 */
const AUDIT_EXPORT_LIMIT = 10_000;

/**
 * CSV export of the audit trail, honouring the same filters as the paginated read.
 *
 * Exporting the audit log is itself recorded (as a CRITICAL access event) — an
 * operator quietly extracting the trail is exactly the kind of action the trail
 * exists to capture.
 */
export const exportAuditLogs = async (c: Context) => {
  try {
    const where = auditWhereFromQuery(c);

    const logs = await db.adminAuditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: AUDIT_EXPORT_LIMIT,
      include: AUDIT_ACTOR_SELECT,
    });

    const header = [
      "id",
      "timestamp",
      "category",
      "severity",
      "action",
      "actor",
      "actorEmail",
      "targetType",
      "targetId",
      "ipAddress",
      "metadata",
    ];
    const rows = logs.map((log) =>
      [
        log.id,
        log.createdAt,
        log.category,
        log.severity,
        log.action,
        log.actorName ?? log.actor?.name ?? null,
        log.actor?.email ?? null,
        log.targetType,
        log.targetId,
        log.ipAddress,
        log.metadata,
      ]
        .map(csvCell)
        .join(",")
    );
    const csv = [header.join(","), ...rows].join("\n");

    await writeAudit(c, "audit.exported", {
      targetType: "auditLog",
      metadata: {
        rowCount: logs.length,
        truncated: logs.length === AUDIT_EXPORT_LIMIT,
        filters: c.req.query(),
      },
    });

    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header(
      "Content-Disposition",
      'attachment; filename="platform-audit-log.csv"'
    );
    return c.body(csv);
  } catch (error) {
    return jsonError(c, {
      status: httpCodes.INTERNAL_SERVER_ERROR,
      code: "INTERNAL_SERVER_ERROR",
      message: error instanceof Error ? error.message : "Internal Server Error",
    });
  }
};
