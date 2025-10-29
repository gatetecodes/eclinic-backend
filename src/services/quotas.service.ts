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

export function getSecondsUntilEndOfMonth(date = new Date()): number {
  const resetAt = endOfMonth(date);
  return Math.max(0, Math.ceil((resetAt.getTime() - date.getTime()) / 1000));
}

export async function getUsage(
  clinicId: number,
  feature: string,
  period = getMonthlyPeriod()
): Promise<number> {
  try {
    const key = getQuotaKey(clinicId, feature, period);
    const val = await redis.get(key);
    return val ? Number(val) : 0;
  } catch (_e) {
    // Resilience: treat as 0 used on read failure (soft fallback)
    return 0;
  }
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
  try {
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
  } catch (_e) {
    // Resilience: no-op on consume failure
    return 0;
  }
}

/**
 * Atomically check-and-increment quota using a Lua script.
 * Returns { allowed, used } where `used` is the new value if allowed, or current value if denied.
 */
export async function tryConsumeAtomic(
  clinicId: number,
  feature: string,
  amount: number,
  limit: number
): Promise<{ allowed: boolean; used: number }> {
  const period = getMonthlyPeriod();
  const ttlSeconds = getSecondsUntilEndOfMonth();
  const key = getQuotaKey(clinicId, feature, period);
  const lua = `
    local key = KEYS[1]
    local amount = tonumber(ARGV[1])
    local limit = tonumber(ARGV[2])
    local ttl = tonumber(ARGV[3])
    local currentStr = redis.call('GET', key)
    local current = 0
    if currentStr then current = tonumber(currentStr) end
    if (current + amount) > limit then
      return {0, current}
    end
    local newVal = redis.call('INCRBY', key, amount)
    local curTtl = redis.call('TTL', key)
    if curTtl < 0 and ttl > 0 then
      redis.call('EXPIRE', key, ttl)
    end
    return {1, newVal}
  `;
  try {
    const res = await redis.eval(lua, 1, key, amount, limit, ttlSeconds);
    if (
      !Array.isArray(res) ||
      res.length !== 2 ||
      typeof res[0] !== "number" ||
      typeof res[1] !== "number"
    ) {
      throw new Error("Unexpected Redis EVAL response");
    }
    const allowed = res[0] === 1;
    const used = res[1];
    return { allowed, used };
  } catch (_e) {
    // On script failure, deny and indicate unknown usage
    return { allowed: false, used: -1 };
  }
}
