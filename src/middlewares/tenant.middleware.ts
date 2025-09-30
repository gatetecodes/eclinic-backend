import type { MiddlewareHandler } from "hono";
import { forbidden } from "@/lib/errors";
import type { AppEnv } from "./auth.middleware";

export const tenantContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  const clinicId = user?.clinic?.id;
  const branchId = user?.branch?.id;

  if (!clinicId) {
    if (user?.role === "SUPER_ADMIN") {
      await next();
      return;
    }
    return forbidden(c, "TENANT_NOT_FOUND");
  }

  c.set("clinicId", clinicId);
  if (branchId) {
    c.set("branchId", branchId);
  }

  await next();
};
