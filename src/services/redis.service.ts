import { Redis } from "ioredis";

if (!process.env.REDIS_HOST) {
  throw new Error("REDIS_HOST is not defined");
}

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: Number.parseInt(process.env.REDIS_PORT || "6379", 10),
  password: process.env.REDIS_PASSWORD,
  db: Number.parseInt(process.env.REDIS_DATABASE || "0", 10),
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  reconnectOnError(error: Error) {
    const targetError = "READONLY";
    if (error.message.includes(targetError)) {
      return true;
    }
    return false;
  },
});

// Cache monitoring stats
type CacheStats = {
  hits: number;
  misses: number;
  keys: Record<string, { hits: number; misses: number }>;
};

const cacheStats: CacheStats = {
  hits: 0,
  misses: 0,
  keys: {},
};

export const DEFAULT_CACHE_TTL = {
  SHORT: 60 * 5, // 5 minutes
  MEDIUM: 60 * 60, // 1 hour
  LONG: 60 * 60 * 24, // 24 hours
};

export const CACHE_KEYS = {
  DASHBOARD: {
    OVERVIEW: "dashboard:overview",
    PATIENTS_AGE: "dashboard:patients:age",
    DEPARTMENTS: "dashboard:departments",
    CASHFLOW: "dashboard:cashflow",
    CLINICS_REVENUE: "dashboard:clinics:revenue",
  },
  ROLE_STATS: {
    DOCTOR: "stats:doctor",
    NURSE: "stats:nurse",
    ACCOUNTANT: "stats:accountant",
  },
  VISITS: "visits",
  VISIT: "visit",
  PATIENTS: "patient",
  INVENTORY: "inventory",
  PAYMENTS: "payments",
  APPOINTMENTS: {
    DOCTOR_AVAILABILITY: "doctor:availability",
    DOCTOR_APPOINTMENTS: "doctor:appointments",
  },
  ANALYTICS: {
    REVENUE: "analytics:revenue",
    VISITS_COUNT: "analytics:visits:count",
    PATIENT_DEMOGRAPHICS: "analytics:patient:demographics",
  },
} as const;

export type RoleType = keyof typeof CACHE_KEYS.ROLE_STATS;

export async function getCachedData<T>(
  key: string,
  fetchFn: () => Promise<T>,
  ttl: number = DEFAULT_CACHE_TTL.MEDIUM
): Promise<T> {
  const cached = await redis.get(key);

  // Record statistics for the base key type (e.g., 'visits', 'patient')
  const baseKey = key.split(":")[0];

  if (!cacheStats.keys[baseKey]) {
    cacheStats.keys[baseKey] = { hits: 0, misses: 0 };
  }

  if (cached) {
    cacheStats.hits++;
    cacheStats.keys[baseKey].hits++;
    return JSON.parse(cached);
  }

  cacheStats.misses++;
  cacheStats.keys[baseKey].misses++;

  const data = await fetchFn();
  await redis.setex(key, ttl, JSON.stringify(data));
  return data;
}

export async function invalidateCache(pattern: string): Promise<void> {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

export async function invalidateDashboardCache(): Promise<void> {
  await invalidateCache(`${CACHE_KEYS.DASHBOARD.OVERVIEW}`);
  await invalidateCache(`${CACHE_KEYS.DASHBOARD.PATIENTS_AGE}*`);
  await invalidateCache(`${CACHE_KEYS.DASHBOARD.DEPARTMENTS}*`);
  await invalidateCache(`${CACHE_KEYS.DASHBOARD.CASHFLOW}*`);
  await invalidateCache(`${CACHE_KEYS.DASHBOARD.CLINICS_REVENUE}`);
}

export async function invalidateRoleStatsCache(
  role: RoleType,
  userId?: string
): Promise<void> {
  if (userId) {
    await invalidateCache(`${CACHE_KEYS.ROLE_STATS[role]}:${userId}`);
  } else {
    await invalidateCache(`${CACHE_KEYS.ROLE_STATS[role]}:*`);
  }
}

export async function invalidateAnalyticsCache(type?: string): Promise<void> {
  if (type) {
    await invalidateCache(
      `${CACHE_KEYS.ANALYTICS[type as keyof typeof CACHE_KEYS.ANALYTICS]}*`
    );
  } else {
    await Promise.all([
      invalidateCache(`${CACHE_KEYS.ANALYTICS.REVENUE}*`),
      invalidateCache(`${CACHE_KEYS.ANALYTICS.VISITS_COUNT}*`),
      invalidateCache(`${CACHE_KEYS.ANALYTICS.PATIENT_DEMOGRAPHICS}*`),
    ]);
  }
}

/**
 * Get cache statistics for monitoring and optimization
 */
export function getCacheStats(): CacheStats {
  return { ...cacheStats };
}

/**
 * Reset cache statistics
 */
export function resetCacheStats(): void {
  cacheStats.hits = 0;
  cacheStats.misses = 0;
  cacheStats.keys = {};
}

/**
 * Get cache hit rate
 */
export function getCacheHitRate(): {
  overall: number;
  byKey: Record<string, number>;
} {
  const total = cacheStats.hits + cacheStats.misses;
  const overall = total > 0 ? cacheStats.hits / total : 0;

  const byKey: Record<string, number> = {};
  for (const [key, stats] of Object.entries(cacheStats.keys)) {
    const keyTotal = stats.hits + stats.misses;
    byKey[key] = keyTotal > 0 ? stats.hits / keyTotal : 0;
  }

  return { overall, byKey };
}

export default redis;
