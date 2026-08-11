import type { MiddlewareHandler } from "hono";
import { db } from "@/database/db";
import { jsonError } from "@/lib/api-response";
import { httpCodes } from "@/lib/constants";
import { unauthorized } from "@/lib/errors";
import type { Translator } from "@/lib/i18n";
import type { SupportedLocale } from "@/lib/locale";
import {
  getCachedSession,
  getSessionCacheKey,
  invalidateCachedUser,
  setCachedSession,
} from "@/lib/session-cache";
import type { User } from "../lib/auth";
import { auth } from "../lib/auth";
import type { Entitlements } from "../types/access";

export type AppVariables = {
  user: User;
  /**
   * Set only when this request is an operator impersonating someone: holds the
   * operator's own user id, while `user` is the account being acted as.
   *
   * Every audited action reads this so the trail records who really did it — the
   * design's banner promises exactly that ("recorded under your platform
   * identity"), and without it an operator's actions would be indistinguishable
   * from the clinician's own.
   */
  impersonatedBy?: number;
  clinicId?: number;
  branchId?: number;
  entitlements?: Entitlements;
  validatedJson?: unknown;
  validatedQuery?: unknown;
  validatedParam?: unknown;
  locale: SupportedLocale;
  localeSource:
    | "default"
    | "header"
    | "accept-language"
    | "user-preference"
    | "clinic-default";
  t: Translator;
};

export type AppEnv = { Variables: AppVariables };

/** A resolved session: who the request acts as, and who is really behind it. */
type ResolvedSession = { user: User; impersonatedBy: number | null };

const pendingSessionLookups = new Map<
  string,
  Promise<ResolvedSession | null>
>();

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return;
};

const normalizeSessionUser = (rawUser: User): User | null => {
  const id = toNumber((rawUser as { id?: unknown }).id);
  if (!id) {
    return null;
  }

  return {
    ...rawUser,
    id,
    patientId: toNumber((rawUser as { patientId?: unknown }).patientId),
    clinicId: toNumber((rawUser as { clinicId?: unknown }).clinicId),
    branchId: toNumber((rawUser as { branchId?: unknown }).branchId),
  } as User;
};

/**
 * Resolve the session, keeping `impersonatedBy` rather than discarding it.
 *
 * The plugin stores it as a string (it models every id as one), so it is coerced
 * here — this is the single place that translation happens.
 */
async function resolveSession(
  c: Parameters<MiddlewareHandler<AppEnv>>[0]
): Promise<ResolvedSession | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return null;
  }
  const user = normalizeSessionUser(session.user as User);
  if (!user) {
    return null;
  }
  const raw = (session.session as { impersonatedBy?: unknown } | undefined)
    ?.impersonatedBy;
  if (raw === undefined || raw === null) {
    return { user, impersonatedBy: null };
  }

  const impersonatedBy = toNumber(raw);
  if (!impersonatedBy) {
    return null;
  }
  const operator = await db.user.findUnique({
    where: { id: impersonatedBy },
    select: { role: true, status: true, banned: true },
  });
  if (
    !operator ||
    operator.role !== "SUPER_ADMIN" ||
    operator.status !== "ACTIVE" ||
    operator.banned === true
  ) {
    return null;
  }
  return { user, impersonatedBy };
}

/**
 * Statuses that revoke access outright. A valid session cookie is not enough —
 * an operator who suspends (BLOCKED) or revokes (INACTIVE) an account expects it
 * to stop working, and without this check a live session outlived the suspension
 * indefinitely.
 *
 * INVITED is deliberately absent: those accounts cannot sign in at all while
 * `requireEmailVerification` is on, so they never reach here with a session.
 */
const REVOKED_STATUSES = new Set(["BLOCKED", "INACTIVE"]);

const isAccessRevoked = (user: User): boolean =>
  REVOKED_STATUSES.has((user as { status?: string }).status ?? "ACTIVE");

const isAccessAuthoritativelyRevoked = async (
  userId: number
): Promise<boolean> => {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { status: true, banned: true },
  });
  return !user || user.banned === true || REVOKED_STATUSES.has(user.status);
};

/**
 * Publish the resolved identity onto the request context.
 *
 * `impersonator` is set only when the session is an impersonation, so downstream
 * code (notably writeAudit) can attribute an action to the real operator as well
 * as the account they are acting as.
 */
function applySession(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  session: ResolvedSession
): void {
  c.set("user", session.user);
  if (session.impersonatedBy !== null) {
    c.set("impersonatedBy", session.impersonatedBy);
  }
}

async function isCachedAccessRevoked(user: User): Promise<boolean> {
  return (
    isAccessRevoked(user) || (await isAccessAuthoritativelyRevoked(user.id))
  );
}

function resolveSessionDeduplicated(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  cookieHeader: string | undefined
): Promise<ResolvedSession | null> {
  const cacheKey = getSessionCacheKey(cookieHeader);
  if (!cacheKey) {
    return resolveSession(c);
  }
  const inFlight = pendingSessionLookups.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }
  const lookupPromise = resolveSession(c).finally(() => {
    pendingSessionLookups.delete(cacheKey);
  });
  pendingSessionLookups.set(cacheKey, lookupPromise);
  return lookupPromise;
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const cookieHeader = c.req.header("cookie");

  try {
    const cached = getCachedSession(cookieHeader);
    if (cached) {
      // The in-process invalidation index cannot observe revocation performed by
      // another app instance, so a cache hit must confirm authoritative state.
      if (await isCachedAccessRevoked(cached.user)) {
        invalidateCachedUser(cookieHeader);
        return unauthorized(c);
      }
      applySession(c, cached);
      await next();
      return;
    }

    const session = await resolveSessionDeduplicated(c, cookieHeader);

    if (!session || isAccessRevoked(session.user)) {
      return unauthorized(c);
    }

    applySession(c, session);
    setCachedSession(cookieHeader, session);
    await next();
  } catch (_error) {
    // Transient auth service/rate-limit failures should not force immediate logout
    const stale = getCachedSession(cookieHeader, { allowStale: true });
    try {
      // ...but never let the stale fallback resurrect an account whose access
      // was revoked locally or by another app instance.
      if (
        stale &&
        !isAccessRevoked(stale.user) &&
        !(await isAccessAuthoritativelyRevoked(stale.user.id))
      ) {
        applySession(c, stale);
        await next();
        return;
      }
    } catch {
      // Fail closed when authoritative revocation state cannot be checked.
    }
    if (stale) {
      invalidateCachedUser(cookieHeader);
    }
    return unauthorized(c);
  }
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (!["SUPER_ADMIN", "CLINIC_ADMIN"].includes(user.role)) {
    return jsonError(c, {
      status: httpCodes.FORBIDDEN,
      code: "FORBIDDEN",
      messageKey: "common.forbidden",
    });
  }
  await next();
};

/**
 * Platform-operator gate. Unlike `requireAdmin` (which also admits
 * CLINIC_ADMIN), this restricts a route to the SaaS operator only. Use it for
 * anything that reads or mutates cross-tenant data (platform stats, global
 * usage, tenant management).
 */
export const requireSuperAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (user.role !== "SUPER_ADMIN") {
    return jsonError(c, {
      status: httpCodes.FORBIDDEN,
      code: "FORBIDDEN",
      messageKey: "common.forbidden",
    });
  }
  await next();
};
