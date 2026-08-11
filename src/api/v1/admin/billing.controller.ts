import type { Context } from "hono";
import { jsonError, jsonSuccess } from "@/lib/api-response";
import { httpCodes } from "@/lib/constants";
import { writeAudit } from "@/services/audit.service";
import { invalidateEntitlements } from "@/services/entitlements.service";
import {
  getPlatformSettings,
  type PlatformSettingsPatch,
  updatePlatformSettings,
} from "@/services/platform-settings.service";
import {
  type Plan,
  Role,
  type SubscriptionPlan,
  SubscriptionStatus,
} from "../../../../generated/prisma/client";
import { db } from "../../../database/db";
import { throwAdminControllerError } from "./controller-error";

/**
 * Statuses that generate revenue. A trial, an onboarding tenant or a suspended
 * one is not paying, so none of them contribute to MRR — counting them would
 * inflate the headline figure the operator makes decisions on.
 */
const BILLABLE_STATUSES: SubscriptionStatus[] = [SubscriptionStatus.ACTIVE];

/**
 * Serialise a Plan for the wire.
 *
 * `monthlyPrice` is a Prisma Decimal, which JSON-encodes as an object rather than
 * a number. Converting here keeps every consumer from having to know that.
 */
function serialisePlan(plan: Plan) {
  return {
    id: plan.id,
    plan: plan.plan,
    label: plan.label,
    description: plan.description,
    monthlyPrice: Number(plan.monthlyPrice),
    currency: plan.currency,
    seatCap: plan.seatCap,
    isActive: plan.isActive,
  };
}

/** Billing state derived from the tenant lifecycle, since there is no biller. */
function billingStatus(status: SubscriptionStatus): string {
  if (status === SubscriptionStatus.ACTIVE) {
    return "current";
  }
  if (status === SubscriptionStatus.TRIAL) {
    return "trial";
  }
  if (status === SubscriptionStatus.SUSPENDED) {
    return "overdue";
  }
  return "not_billed";
}

/** The price catalogue. Read by the settings screen and the change-plan modal. */
export const getPlans = async (c: Context) => {
  try {
    const plans = await db.plan.findMany({ orderBy: { monthlyPrice: "asc" } });
    return jsonSuccess(c, { data: plans.map(serialisePlan) });
  } catch (error) {
    throwAdminControllerError("admin.billing.plans_load_failed", error);
  }
};

/**
 * Update one tier's commercial terms.
 *
 * Does not touch entitlements: what a plan *includes* comes from FEATURE_MATRIX,
 * and only what it *costs* lives here. Repricing a tier must never silently change
 * what clinics on it can do.
 */
export const updatePlan = async (c: Context) => {
  try {
    const planKey = c.req.param("plan") as SubscriptionPlan;
    const patch = c.get("validatedJson") as {
      label?: string;
      description?: string | null;
      monthlyPrice?: number;
      seatCap?: number | null;
      isActive?: boolean;
    };

    const existing = await db.plan.findUnique({ where: { plan: planKey } });
    if (!existing) {
      return jsonError(c, {
        status: httpCodes.NOT_FOUND,
        code: "NOT_FOUND",
        message: "Plan not found",
      });
    }

    const updated = await db.plan.update({
      where: { plan: planKey },
      data: patch,
    });

    await writeAudit(c, "plan.updated", {
      targetType: "plan",
      targetId: updated.id,
      metadata: {
        plan: planKey,
        fields: Object.keys(patch),
        priceFrom: Number(existing.monthlyPrice),
        priceTo: Number(updated.monthlyPrice),
      },
    });

    return jsonSuccess(c, { data: serialisePlan(updated) });
  } catch (error) {
    throwAdminControllerError("admin.billing.plan_update_failed", error);
  }
};

/**
 * Subscription roster: one row per live clinic with its plan, seat usage, derived
 * MRR and renewal date, plus the four headline figures.
 *
 * Seats are counted live from User rather than stored, so the number cannot drift
 * from reality. Over-cap tenants are flagged — that is the operator's cue to
 * upsell, and it is invisible otherwise.
 */
export const getSubscriptions = async (c: Context) => {
  try {
    const [plans, clinics, seatCounts] = await Promise.all([
      db.plan.findMany(),
      db.clinic.findMany({
        where: { archivedAt: null },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          subscriptionPlan: true,
          subscriptionStatus: true,
          subscriptionExpiryDate: true,
          defaultCurrency: true,
        },
      }),
      db.user.groupBy({
        by: ["clinicId"],
        where: {
          role: { not: Role.PATIENT },
          status: { in: ["ACTIVE", "INVITED"] },
        },
        _count: { id: true },
      }),
    ]);

    const planByKey = new Map(plans.map((plan) => [plan.plan, plan]));
    const seatsByClinic = new Map(
      seatCounts
        .filter((row) => row.clinicId !== null)
        .map((row) => [row.clinicId as number, row._count.id])
    );

    const rows = clinics.map((clinic) => {
      const plan = planByKey.get(clinic.subscriptionPlan);
      const seats = seatsByClinic.get(clinic.id) ?? 0;
      const billable = BILLABLE_STATUSES.includes(clinic.subscriptionStatus);
      const price = plan ? Number(plan.monthlyPrice) : null;

      return {
        clinicId: clinic.id,
        name: clinic.name,
        plan: clinic.subscriptionPlan,
        planLabel: plan?.label ?? clinic.subscriptionPlan,
        status: clinic.subscriptionStatus,
        billingStatus: billingStatus(clinic.subscriptionStatus),
        seats,
        seatCap: plan?.seatCap ?? null,
        overCap:
          plan?.seatCap !== null && plan?.seatCap !== undefined
            ? seats > plan.seatCap
            : false,
        // Only billable tenants carry MRR; others show a dash, not a price they
        // are not being charged.
        mrr: billable ? price : null,
        currency: plan?.currency ?? clinic.defaultCurrency,
        renewsAt: clinic.subscriptionExpiryDate,
      };
    });

    const billableRows = rows.filter((row) => row.mrr !== null);
    const totalMrr = billableRows.reduce((sum, row) => sum + (row.mrr ?? 0), 0);
    const atRisk = rows.filter(
      (row) =>
        row.status === SubscriptionStatus.SUSPENDED ||
        row.status === SubscriptionStatus.TRIAL
    ).length;

    return jsonSuccess(c, {
      data: {
        kpis: {
          monthlyRecurringRevenue: totalMrr,
          payingClinics: { value: billableRows.length, total: rows.length },
          // Average revenue per paying clinic, not per clinic — dividing by the
          // whole roster would understate it by counting trials.
          averageRevenue:
            billableRows.length > 0
              ? Math.round(totalMrr / billableRows.length)
              : 0,
          atRisk,
        },
        rows,
      },
    });
  } catch (error) {
    throwAdminControllerError("admin.billing.subscriptions_load_failed", error);
  }
};

/**
 * Move a clinic to a different tier.
 *
 * Invalidates the entitlement cache because the plan decides the whole
 * FEATURE_MATRIX row — without this the clinic would keep its old feature set
 * until the cache expired.
 */
export const updateClinicPlan = async (c: Context) => {
  try {
    const clinicId = Number(c.req.param("id"));
    if (!Number.isInteger(clinicId) || clinicId <= 0) {
      return jsonError(c, {
        status: httpCodes.BAD_REQUEST,
        code: "BAD_REQUEST",
        messageKey: "common.invalidId",
      });
    }
    const { plan } = c.get("validatedJson") as { plan: SubscriptionPlan };

    const clinic = await db.clinic.findUnique({
      where: { id: clinicId },
      select: { id: true, subscriptionPlan: true },
    });
    if (!clinic) {
      return jsonError(c, {
        status: httpCodes.NOT_FOUND,
        code: "NOT_FOUND",
        message: "Clinic not found",
      });
    }

    const updated = await db.clinic.update({
      where: { id: clinicId },
      data: { subscriptionPlan: plan },
      select: {
        id: true,
        name: true,
        subscriptionPlan: true,
        subscriptionStatus: true,
      },
    });
    await invalidateEntitlements(clinicId);

    await writeAudit(c, "clinic.planChanged", {
      targetType: "clinic",
      targetId: clinicId,
      metadata: { from: clinic.subscriptionPlan, to: plan },
    });

    return jsonSuccess(c, { data: updated });
  } catch (error) {
    throwAdminControllerError("admin.billing.clinic_plan_update_failed", error);
  }
};

/**
 * Per-clinic subscription facts for the drill-down's Subscription tab.
 *
 * No invoice history: there is no invoicing system behind this, and the response
 * says so explicitly rather than returning an empty list the UI might render as
 * "no invoices yet".
 */
export const getClinicSubscription = async (c: Context) => {
  try {
    const clinicId = Number(c.req.param("id"));
    if (!Number.isInteger(clinicId) || clinicId <= 0) {
      return jsonError(c, {
        status: httpCodes.BAD_REQUEST,
        code: "BAD_REQUEST",
        messageKey: "common.invalidId",
      });
    }

    const clinic = await db.clinic.findUnique({
      where: { id: clinicId },
      select: {
        id: true,
        subscriptionPlan: true,
        subscriptionStatus: true,
        subscriptionExpiryDate: true,
        convertedAt: true,
        createdAt: true,
      },
    });
    if (!clinic) {
      return jsonError(c, {
        status: httpCodes.NOT_FOUND,
        code: "NOT_FOUND",
        message: "Clinic not found",
      });
    }

    const [plan, seats] = await Promise.all([
      db.plan.findUnique({ where: { plan: clinic.subscriptionPlan } }),
      db.user.count({
        where: {
          clinicId,
          role: { not: Role.PATIENT },
          status: { in: ["ACTIVE", "INVITED"] },
        },
      }),
    ]);

    const billable = BILLABLE_STATUSES.includes(clinic.subscriptionStatus);

    return jsonSuccess(c, {
      data: {
        plan: plan ? serialisePlan(plan) : null,
        status: clinic.subscriptionStatus,
        billingStatus: billingStatus(clinic.subscriptionStatus),
        mrr: billable && plan ? Number(plan.monthlyPrice) : null,
        seats,
        seatCap: plan?.seatCap ?? null,
        renewsAt: clinic.subscriptionExpiryDate,
        convertedAt: clinic.convertedAt,
        onPlatformSince: clinic.createdAt,
        // Stated rather than implied by an empty array.
        invoices: { status: "not_tracked", items: [] },
        paymentMethod: { status: "not_tracked" },
      },
    });
  } catch (error) {
    throwAdminControllerError(
      "admin.billing.clinic_subscription_load_failed",
      error
    );
  }
};

/** Global platform configuration. */
export const getSettings = async (c: Context) => {
  try {
    const settings = await getPlatformSettings();
    return jsonSuccess(c, { data: settings });
  } catch (error) {
    throwAdminControllerError("admin.billing.settings_load_failed", error);
  }
};

export const updateSettings = async (c: Context) => {
  try {
    // The validated body carries plain scalars, not Prisma's update operators, so
    // the service's own patch type is the accurate one here.
    const patch = c.get("validatedJson") as PlatformSettingsPatch;
    const settings = await updatePlatformSettings(patch);

    await writeAudit(c, "platform.settingsUpdated", {
      targetType: "platform",
      metadata: { fields: Object.keys(patch) },
    });

    return jsonSuccess(c, { data: settings });
  } catch (error) {
    throwAdminControllerError("admin.billing.settings_update_failed", error);
  }
};
