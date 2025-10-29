import type { MiddlewareHandler } from "hono";
import type { Action, FeatureKey, Resource } from "@/types/access";
import type { AppEnv } from "./auth.middleware";
import { requireFeature } from "./feature.middleware";
import { requirePermission } from "./rbac.middleware";

export function withAccess(config: {
  resource?: Resource;
  action?: Action;
  feature?: FeatureKey;
}): MiddlewareHandler<AppEnv>[] {
  const mws: MiddlewareHandler<AppEnv>[] = [];
  if (config.resource && config.action) {
    mws.push(
      requirePermission({ resource: config.resource, action: config.action })
    );
  }
  if (config.feature) {
    mws.push(requireFeature(config.feature));
  }
  return mws;
}
