import { endOfMonth, format } from "date-fns";
import { db } from "@/database/db";
import redis from "./redis.service";

export type QuotaInfo = {
  limit?: number;
  used: number;
  remaining?: number;
  period: string; // e.g., 2025-10
  resetAt?: string; // ISO
};

export function getMonthlyPeriod(date = new Date()): string {
  return format(date, "yyyy-MM");
}

export function getQuotaKey(
  clinicId: number,
  feature: string,
  period: string
): string {
  return `quota:clinic:${clinicId}:${feature}:${period}`;
}

export async function getUsage(
  clinicId: number,
  feature: string,
  period = getMonthlyPeriod()
): Promise<number> {
  const key = getQuotaKey(clinicId, feature, period);
  const val = await redis.get(key);
  return val ? Number(val) : 0;
}

export async function setInitialTtlIfNeeded(
  key: string,
  date = new Date()
): Promise<void> {
  const ttl = await redis.ttl(key);
  if (ttl < 0) {
    const resetAt = endOfMonth(date);
    const seconds = Math.ceil((resetAt.getTime() - Date.now()) / 1000);
    if (seconds > 0) {
      await redis.expire(key, seconds);
    }
  }
}

export async function consume(
  clinicId: number,
  feature: string,
  amount: number,
  period = getMonthlyPeriod()
): Promise<number> {
  const key = getQuotaKey(clinicId, feature, period);
  const used = await redis.incrby(key, amount);
  await setInitialTtlIfNeeded(key);
  // best-effort persist to DB
  await db.entitlementUsage.upsert({
    where: {
      clinicId_featureKey_period: { clinicId, featureKey: feature, period },
    },
    update: { count: used },
    create: { clinicId, featureKey: feature, period, count: used },
  });
  return used;
}
