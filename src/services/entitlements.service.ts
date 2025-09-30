import { isAfter } from "date-fns";
import { db } from "../database/db";
import { FEATURE_MATRIX } from "../lib/entitlements-matrix";
import type { Entitlements, FeatureKey } from "../types/access";
import redis, { DEFAULT_CACHE_TTL } from "./redis.service";

const ENTITLEMENTS_CACHE_PREFIX = "entitlements:clinic";

function getEntitlementsCacheKey(clinicId: number): string {
  return `${ENTITLEMENTS_CACHE_PREFIX}:${clinicId}`;
}

function toEntitlements(
  plan: keyof typeof FEATURE_MATRIX,
  status: "ACTIVE" | "TRIAL" | "INACTIVE" | "EXPIRED"
): Entitlements {
  const features = FEATURE_MATRIX[plan];
  if (status === "INACTIVE" || status === "EXPIRED") {
    return {
      status,
      features: Object.fromEntries(
        Object.keys(features).map((k) => [k, false])
      ) as Entitlements["features"],
    };
  }
  return { status, features };
}

export async function computeClinicEntitlements(
  clinicId: number
): Promise<Entitlements> {
  const clinic = await db.clinic.findUnique({
    where: { id: clinicId },
    select: {
      subscriptionPlan: true,
      subscriptionStatus: true,
      subscriptionExpiryDate: true,
    },
  });

  if (!clinic) {
    return toEntitlements("CLINIC_STARTER", "INACTIVE");
  }

  const now = new Date();
  const isExpired =
    clinic.subscriptionExpiryDate != null &&
    isAfter(now, clinic.subscriptionExpiryDate);

  const status: "ACTIVE" | "TRIAL" | "INACTIVE" | "EXPIRED" = isExpired
    ? "EXPIRED"
    : (clinic.subscriptionStatus as unknown as Entitlements["status"]);

  const base = toEntitlements(
    clinic.subscriptionPlan as keyof typeof FEATURE_MATRIX,
    status
  );

  // Apply overrides (allow/deny and limits)
  const overrides = await db.entitlementOverride.findMany({
    where: { clinicId },
    select: { featureKey: true, allowed: true, limit: true },
  });

  const mergedFeatures: Record<FeatureKey, boolean> = {
    ...base.features,
  } as Record<FeatureKey, boolean>;
  for (const ov of overrides) {
    const key = ov.featureKey as FeatureKey;
    if (!(key in mergedFeatures)) {
      //Skip invalid/unknown feature keys
      continue;
    }
    if (ov.allowed === true) {
      mergedFeatures[key] = true;
    }
    if (ov.allowed === false) {
      mergedFeatures[key] = false;
    }
  }

  const limits: Record<FeatureKey, number | undefined> = {} as Record<
    FeatureKey,
    number | undefined
  >;
  for (const ov of overrides) {
    const key = ov.featureKey as FeatureKey;
    if (typeof ov.limit === "number") {
      limits[key] = ov.limit;
    }
  }

  return { status: base.status, features: mergedFeatures, limits };
}

export async function getCachedEntitlements(
  clinicId: number,
  ttlSeconds: number = DEFAULT_CACHE_TTL.MEDIUM
): Promise<Entitlements> {
  const cacheKey = getEntitlementsCacheKey(clinicId);
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as Entitlements;
  }
  const entitlements = await computeClinicEntitlements(clinicId);
  await redis.setex(cacheKey, ttlSeconds, JSON.stringify(entitlements));
  return entitlements;
}

export async function invalidateEntitlements(clinicId: number): Promise<void> {
  const cacheKey = getEntitlementsCacheKey(clinicId);
  await redis.del(cacheKey);
}
