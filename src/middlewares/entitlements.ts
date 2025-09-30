import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "@/lib/constants";
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
    return c.json(
      {
        error: "Error getting entitlements",
        status: httpCodes.INTERNAL_SERVER_ERROR,
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
  c.set("entitlements", entitlements);

  await next();
};
