import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "@/lib/constants";
import type { User } from "../lib/auth";
import { auth } from "../lib/auth";

export type AppVariables = {
  user: User;
};

export type AppEnv = { Variables: AppVariables };

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) {
      return c.json(
        { error: "Unauthorized", status: httpCodes.UNAUTHORIZED },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    c.set("user", session.user as User);
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
