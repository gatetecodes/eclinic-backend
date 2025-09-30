import type { MiddlewareHandler } from "hono";
import { forbidden, unauthorized } from "@/lib/errors";
import { hasPermission } from "@/lib/permissions";
import type { Action, FeatureKey, Resource } from "@/types/access";
import type { AppEnv } from "./auth";

function methodToAction(method: string): Action {
  switch (method) {
    case "GET":
      return "read";
    case "POST":
      return "create";
    case "PUT":
    case "PATCH":
      return "update";
    case "DELETE":
      return "delete";
    default:
      return "read";
  }
}

export function crudAccess(
  resource: Resource,
  feature?: FeatureKey
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) {
      return unauthorized(c);
    }

    // SUPER_ADMIN bypasses both feature and RBAC
    if (user.role === "SUPER_ADMIN") {
      await next();
      return;
    }

    // Feature gating (if provided)
    if (feature) {
      const entitlements = c.get("entitlements");
      if (!entitlements || entitlements.features[feature] !== true) {
        return forbidden(c, "FEATURE_DISABLED", {
          feature,
          status: entitlements?.status,
        });
      }
    }

    // RBAC
    const action = methodToAction(c.req.method);
    const allowed = hasPermission(user, resource, action);
    if (!allowed) {
      return forbidden(c, "RBAC_DENIED", { resource, action });
    }

    await next();
  };
}
