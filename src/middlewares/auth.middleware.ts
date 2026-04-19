import type { MiddlewareHandler } from "hono";
import { jsonError } from "@/lib/api-response";
import { httpCodes } from "@/lib/constants";
import { unauthorized } from "@/lib/errors";
import type { Translator } from "@/lib/i18n";
import type { SupportedLocale } from "@/lib/locale";
import { getCachedUser, setCachedUser } from "@/lib/session-cache";
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

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    const cookieHeader = c.req.header("cookie");
    const cached = getCachedUser(cookieHeader);
    if (cached) {
      c.set("user", cached as User);
      await next();
      return;
    }

    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) {
      return unauthorized(c);
    }
    const user = session.user as User;
    c.set("user", user);
    setCachedUser(cookieHeader, user);
    await next();
  } catch (_error) {
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
