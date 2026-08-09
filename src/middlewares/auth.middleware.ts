import type { MiddlewareHandler } from "hono";
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
  return { user, impersonatedBy: toNumber(raw) ?? null };
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

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const cookieHeader = c.req.header("cookie");

  try {
    const cached = getCachedSession(cookieHeader);
    if (cached) {
      // Normally the endpoint that revoked access also purged the cache; this
      // catches the entry going stale by any other route (direct DB edit, a
      // second app instance). Purge so the next request re-reads the real status
      // rather than looping on a stale allow.
      if (isAccessRevoked(cached.user)) {
        invalidateCachedUser(cookieHeader);
        return unauthorized(c);
      }
      applySession(c, cached);
      await next();
      return;
    }

    const cacheKey = getSessionCacheKey(cookieHeader);
    let session: ResolvedSession | null = null;

    if (cacheKey) {
      const inFlight = pendingSessionLookups.get(cacheKey);
      if (inFlight) {
        session = await inFlight;
      } else {
        const lookupPromise = resolveSession(c).finally(() => {
          pendingSessionLookups.delete(cacheKey);
        });
        pendingSessionLookups.set(cacheKey, lookupPromise);
        session = await lookupPromise;
      }
    } else {
      session = await resolveSession(c);
    }

    if (!session || isAccessRevoked(session.user)) {
      return unauthorized(c);
    }

    applySession(c, session);
    setCachedSession(cookieHeader, session);
    await next();
  } catch (_error) {
    // Transient auth service/rate-limit failures should not force immediate logout
    const stale = getCachedSession(cookieHeader, { allowStale: true });
    // ...but never let the stale fallback resurrect an account whose access was
    // revoked, or a suspension would be bypassable for the whole stale window.
    if (stale && !isAccessRevoked(stale.user)) {
      applySession(c, stale);
      await next();
      return;
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
