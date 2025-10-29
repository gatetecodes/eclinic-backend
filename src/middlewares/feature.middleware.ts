import type { MiddlewareHandler } from "hono";
import { forbidden, unauthorized } from "@/lib/errors";
import type { FeatureKey } from "@/types/access";
import type { AppEnv } from "./auth.middleware";

export function requireFeature(feature: FeatureKey): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) {
      return unauthorized(c);
    }
    if (user.role === "SUPER_ADMIN") {
      await next();
      return;
    }
    const entitlements = c.get("entitlements");
    if (!entitlements || entitlements.features[feature] !== true) {
      return forbidden(c, "FEATURE_DISABLED", {
        feature,
        status: entitlements?.status,
      });
    }
    await next();
  };
}
