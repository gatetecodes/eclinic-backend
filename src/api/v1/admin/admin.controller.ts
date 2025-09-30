import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "@/lib/constants";
import {
  getCachedEntitlements,
  invalidateEntitlements,
} from "@/services/entitlements.service";
import { db } from "../../../database/db";

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

    await db.$transaction(async (tx) =>
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

    await invalidateEntitlements(clinicId);
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

export const getEntitlementUsageSummary = async (c: Context) => {
  try {
    const period = new Date().toISOString().slice(0, 7);
    const rows = await db.entitlementUsage.findMany({
      where: { period },
      select: { clinicId: true, featureKey: true, count: true },
    });
    return c.json({ data: rows }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
