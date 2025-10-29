import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "@/lib/constants";
import { getCachedUser, setCachedUser } from "@/lib/session-cache";
import type { User } from "../lib/auth";
import { auth } from "../lib/auth";
import type { Entitlements } from "../types/access";

export type AppVariables = {
  user: User;
  clinicId?: number;
  branchId?: number;
  entitlements?: Entitlements;
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
      return c.json(
        { error: "Unauthorized", status: httpCodes.UNAUTHORIZED },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    const user = session.user as User;
    c.set("user", user);
    setCachedUser(cookieHeader, user);
    await next();
  } catch (_error) {
    return c.json(
      { error: "Unauthorized", status: httpCodes.UNAUTHORIZED },
      httpCodes.UNAUTHORIZED as ContentfulStatusCode
    );
  }
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (!["SUPER_ADMIN", "CLINIC_ADMIN"].includes(user.role)) {
    return c.json(
      { error: "Forbidden", status: httpCodes.FORBIDDEN },
      httpCodes.FORBIDDEN as ContentfulStatusCode
    );
  }
  await next();
};
