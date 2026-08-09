import type { User } from "./auth";

/**
 * A resolved session.
 *
 * `impersonatedBy` is cached alongside the user because it belongs to the session
 * rather than to the user, and a cache hit skips the session lookup entirely.
 * Without it, every request served from cache during an impersonation would look
 * like a genuine action by the impersonated user, and the audit trail would
 * attribute operator actions to a clinician.
 */
type ResolvedSession = { user: User; impersonatedBy: number | null };

type CacheEntry = ResolvedSession & { cachedAt: number };

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

/**
 * userId → the cache keys currently holding an entry for that user, either as
 * the resolved identity or as the operator behind an impersonated session.
 *
 * The cache is keyed by session cookie, but privileged operations act on a user
 * (suspend, change role, end impersonation) and must take effect on the very next
 * request rather than waiting out the TTL. Without this reverse index there is no
 * way to find a user's entries, since one user can have several concurrent
 * sessions across devices.
 */
const keysByUser = new Map<number, Set<string>>();

function indexedUserIds(entry: ResolvedSession): number[] {
  if (entry.impersonatedBy !== null && entry.impersonatedBy !== entry.user.id) {
    return [entry.user.id, entry.impersonatedBy];
  }
  return [entry.user.id];
}

function forgetKey(cacheKey: string): void {
  const entry = cache.get(cacheKey);
  cache.delete(cacheKey);
  if (!entry) {
    return;
  }
  for (const userId of indexedUserIds(entry)) {
    const keys = keysByUser.get(userId);
    if (!keys) {
      continue;
    }
    keys.delete(cacheKey);
    if (keys.size === 0) {
      keysByUser.delete(userId);
    }
  }
}

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

export function getCachedSession(
  cookieHeader: string | undefined,
  options?: { allowStale?: boolean }
): ResolvedSession | null {
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
    forgetKey(cacheKey);
    return null;
  }

  if (ageMs > CACHE_TTL_MS && !options?.allowStale) {
    return null;
  }

  return { user: entry.user, impersonatedBy: entry.impersonatedBy };
}

export function setCachedSession(
  cookieHeader: string | undefined,
  session: ResolvedSession
): void {
  const cacheKey = getSessionCacheKey(cookieHeader);
  if (!cacheKey) {
    return;
  }
  // Clear every previous reverse-index membership before re-pointing this key.
  if (cache.has(cacheKey)) {
    forgetKey(cacheKey);
  }

  cache.set(cacheKey, { ...session, cachedAt: Date.now() });

  for (const userId of indexedUserIds(session)) {
    const keys = keysByUser.get(userId);
    if (keys) {
      keys.add(cacheKey);
    } else {
      keysByUser.set(userId, new Set([cacheKey]));
    }
  }
}

/**
 * Drop the entry for one session cookie. Use when the request itself has proven
 * the cached identity is no longer valid (e.g. the account is now blocked).
 */
export function invalidateCachedUser(cookieHeader: string | undefined): void {
  const cacheKey = getSessionCacheKey(cookieHeader);
  if (cacheKey) {
    forgetKey(cacheKey);
  }
}

/**
 * Drop every cached session for a user, across all their devices. Call after any
 * change to what the user is allowed to do — status, role, clinic assignment, or
 * starting/ending impersonation — otherwise the change is invisible for up to the
 * stale TTL (15 minutes by default).
 *
 * This only clears the in-process cache; it does not revoke the Better-Auth
 * session itself. Callers that need the user actually signed out must delete the
 * Session rows as well.
 */
export function invalidateUserSessions(userId: number): void {
  const keys = keysByUser.get(userId);
  if (!keys) {
    return;
  }
  for (const cacheKey of [...keys]) {
    forgetKey(cacheKey);
  }
}
