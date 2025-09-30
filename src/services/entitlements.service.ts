import { isAfter } from "date-fns";
import { db } from "../database/db";
import { FEATURE_MATRIX } from "../lib/entitlements-matrix";
import type { Entitlements } from "../types/access";
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

  return toEntitlements(
    clinic.subscriptionPlan as keyof typeof FEATURE_MATRIX,
    status
  );
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
