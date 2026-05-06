import type { User } from "./auth";

type CacheEntry = { user: User; cachedAt: number };

const configuredTTL = Number(process.env.SESSION_CACHE_TTL_MS ?? "300000");
const CACHE_TTL_MS =
  Number.isFinite(configuredTTL) && configuredTTL >= 0
    ? configuredTTL
    : 300_000; // 5 minutes

const configuredStaleTTL = Number(
  process.env.SESSION_CACHE_STALE_TTL_MS ?? "900000"
);
const CACHE_STALE_TTL_MS =
  Number.isFinite(configuredStaleTTL) && configuredStaleTTL >= CACHE_TTL_MS
    ? configuredStaleTTL
    : 900_000; // 15 minutes

const SESSION_COOKIE_KEYS = ["session_token", "__Secure-session_token"];

const cache = new Map<string, CacheEntry>();

function parseCookieHeader(cookieHeader: string): Map<string, string> {
  const cookies = new Map<string, string>();
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [rawName, ...rest] = part.split("=");
    const name = rawName?.trim();
    if (!name) {
      continue;
    }
    const value = rest.join("=").trim();
    cookies.set(name, value);
  }
  return cookies;
}

export function getSessionCacheKey(
  cookieHeader: string | undefined
): string | null {
  if (!cookieHeader) {
    return null;
  }

  const parsed = parseCookieHeader(cookieHeader);
  for (const key of SESSION_COOKIE_KEYS) {
    const token = parsed.get(key);
    if (token) {
      return `session:${token}`;
    }
  }

  const normalizedCookieHeader = cookieHeader.trim();
  if (!normalizedCookieHeader) {
    return null;
  }

  return `cookie:${normalizedCookieHeader}`;
}

export function getCachedUser(
  cookieHeader: string | undefined,
  options?: { allowStale?: boolean }
): User | null {
  const cacheKey = getSessionCacheKey(cookieHeader);
  if (!cacheKey) {
    return null;
  }

  const entry = cache.get(cacheKey);
  if (!entry) {
    return null;
  }

  const ageMs = Date.now() - entry.cachedAt;
  if (ageMs > CACHE_STALE_TTL_MS) {
    cache.delete(cacheKey);
    return null;
  }

  if (ageMs > CACHE_TTL_MS && !options?.allowStale) {
    return null;
  }

  return entry.user;
}

export function setCachedUser(
  cookieHeader: string | undefined,
  user: User
): void {
  const cacheKey = getSessionCacheKey(cookieHeader);
  if (!cacheKey) {
    return;
  }
  cache.set(cacheKey, { user, cachedAt: Date.now() });
}
