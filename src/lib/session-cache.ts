import type { User } from "./auth";

type CacheEntry = { user: User; cachedAt: number };

const CACHE_TTL_MS = Number(process.env.SESSION_CACHE_TTL_MS ?? "1000"); // 1 second
const cache = new Map<string, CacheEntry>();

export function getCachedUser(cookieHeader: string | undefined): User | null {
  if (!cookieHeader) {
    return null;
  }
  const entry = cache.get(cookieHeader);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    cache.delete(cookieHeader);
    return null;
  }
  return entry.user;
}

export function setCachedUser(
  cookieHeader: string | undefined,
  user: User
): void {
  if (!cookieHeader) {
    return;
  }
  cache.set(cookieHeader, { user, cachedAt: Date.now() });
}
