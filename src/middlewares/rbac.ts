import type { MiddlewareHandler } from "hono";
import { forbidden, unauthorized } from "@/lib/errors";
import { hasPermission } from "@/lib/permissions";
import type { Action, Resource } from "@/types/access";
import type { AppEnv } from "./auth";

export function requirePermission(config: {
  resource: Resource;
  action: Action;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) {
      return unauthorized(c);
    }
    if (user.role === "SUPER_ADMIN") {
      await next();
      return;
    }
    const allowed = hasPermission(user, config.resource, config.action);
    if (!allowed) {
      return forbidden(c, "RBAC_DENIED", {
        resource: config.resource,
        action: config.action,
      });
    }
    await next();
  };
}
