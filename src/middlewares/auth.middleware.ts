import type { MiddlewareHandler } from "hono";
import { jsonError } from "@/lib/api-response";
import { httpCodes } from "@/lib/constants";
import { unauthorized } from "@/lib/errors";
import type { Translator } from "@/lib/i18n";
import type { SupportedLocale } from "@/lib/locale";
import {
  getCachedUser,
  getSessionCacheKey,
  setCachedUser,
} from "@/lib/session-cache";
import type { User } from "../lib/auth";
import { auth } from "../lib/auth";
import type { Entitlements } from "../types/access";

export type AppVariables = {
  user: User;
  clinicId?: number;
  branchId?: number;
  entitlements?: Entitlements;
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

const pendingSessionLookups = new Map<string, Promise<User | null>>();

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

async function resolveSessionUser(c: Parameters<MiddlewareHandler<AppEnv>>[0]) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return null;
  }
  return normalizeSessionUser(session.user as User);
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const cookieHeader = c.req.header("cookie");

  try {
    const cached = getCachedUser(cookieHeader);
    if (cached) {
      c.set("user", cached as User);
      await next();
      return;
    }

    const cacheKey = getSessionCacheKey(cookieHeader);
    let user: User | null = null;

    if (cacheKey) {
      const inFlight = pendingSessionLookups.get(cacheKey);
      if (inFlight) {
        user = await inFlight;
      } else {
        const lookupPromise = resolveSessionUser(c).finally(() => {
          pendingSessionLookups.delete(cacheKey);
        });
        pendingSessionLookups.set(cacheKey, lookupPromise);
        user = await lookupPromise;
      }
    } else {
      user = await resolveSessionUser(c);
    }

    if (!user) {
      return unauthorized(c);
    }

    c.set("user", user);
    setCachedUser(cookieHeader, user);
    await next();
  } catch (_error) {
    // Transient auth service/rate-limit failures should not force immediate logout
    const stale = getCachedUser(cookieHeader, { allowStale: true });
    if (stale) {
      c.set("user", stale as User);
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
