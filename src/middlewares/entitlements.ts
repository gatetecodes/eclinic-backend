import type { MiddlewareHandler } from "hono";
import { internalServerError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getCachedEntitlements } from "@/services/entitlements.service";
import type { Entitlements } from "@/types/access";
import type { AppEnv } from "./auth";

export const entitlementsContext: MiddlewareHandler<AppEnv> = async (
  c,
  next
) => {
  const user = c.get("user");
  // SUPER_ADMIN bypass: no entitlements needed
  if (user?.role === "SUPER_ADMIN") {
    return await next();
  }
  const clinicId = c.get("clinicId");
  if (typeof clinicId !== "number") {
    return await next();
  }
  let entitlements: Entitlements | null = null;

  try {
    entitlements = await getCachedEntitlements(clinicId);
  } catch (error) {
    logger.error("Error getting entitlements", { error });
    return internalServerError(c);
  }
  c.set("entitlements", entitlements);

  await next();
};
