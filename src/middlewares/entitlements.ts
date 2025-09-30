import type { MiddlewareHandler } from "hono";
import { getCachedEntitlements } from "@/services/entitlements.service";
import type { AppEnv } from "./auth";

export const entitlementsContext: MiddlewareHandler<AppEnv> = async (
  c,
  next
) => {
  const user = c.get("user");
  // SUPER_ADMIN bypass: no entitlements needed
  if (user?.role === "SUPER_ADMIN") {
    return next();
  }
  const clinicId = c.get("clinicId");
  if (typeof clinicId !== "number") {
    return next();
  }
  const entitlements = await getCachedEntitlements(clinicId);
  c.set("entitlements", entitlements);
  await next();
};
