import { type MiddlewareHandler } from "hono";
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
      return c.json({ error: "Unauthorized" }, 401);
    }
    c.set("user", session.user as User);
    await next();
  } catch (error) {
    console.error("Auth middleware error:", error);
    return c.json({ error: "Unauthorized" }, 401);
  }
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (!["SUPER_ADMIN", "CLINIC_ADMIN"].includes(user.role)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  await next();
};
