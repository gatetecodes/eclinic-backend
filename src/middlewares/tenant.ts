import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "@/lib/constants";
import type { AppEnv } from "./auth";

export const tenantContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  const clinicId = user?.clinic?.id;
  const branchId = user?.branch?.id;

  if (!clinicId) {
    // SUPER_ADMIN can operate without a bound clinic context
    if (user?.role === "SUPER_ADMIN") {
      await next();
      return;
    }
    return c.json(
      { error: "Forbidden", reason: "TENANT_NOT_FOUND" },
      httpCodes.FORBIDDEN as ContentfulStatusCode
    );
  }

  c.set("clinicId", clinicId);
  if (branchId) {
    c.set("branchId", branchId);
  }

  await next();
};
