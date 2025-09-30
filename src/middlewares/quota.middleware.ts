import type { MiddlewareHandler } from "hono";
import { forbidden } from "@/lib/errors";
import { consume, getMonthlyPeriod, getUsage } from "@/services/quotas.service";
import type { FeatureKey } from "@/types/access";
import type { AppEnv } from "./auth.middleware";

type Mode = "soft" | "hard";

export function requireQuota(
  feature: FeatureKey,
  amount = 1,
  mode: Mode = (process.env.QUOTAS_MODE as Mode) || "hard"
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get("user");
    if (user?.role === "SUPER_ADMIN") {
      await next();
      return;
    }
    const entitlements = c.get("entitlements");
    const clinicId = c.get("clinicId");
    if (!entitlements || typeof clinicId !== "number") {
      return forbidden(c, "FEATURE_DISABLED", { feature });
    }

    const period = getMonthlyPeriod();
    const limit = entitlements.limits?.[feature];
    const used = await getUsage(clinicId, feature, period);

    c.header("X-Quota-Period", period);
    if (typeof limit === "number") {
      const remaining = Math.max(limit - used, 0);
      c.header("X-Quota-Limit", String(limit));
      c.header("X-Quota-Used", String(used));
      c.header("X-Quota-Remaining", String(remaining));
      if (used + amount > limit && mode === "hard") {
        return forbidden(c, "QUOTA_EXCEEDED", { feature, limit, used, period });
      }
    }

    await next();
    if (c.res.status >= 200 && c.res.status < 400) {
      await consume(clinicId, feature, amount, period);
    }
  };
}
