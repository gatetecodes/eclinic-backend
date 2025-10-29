import type { MiddlewareHandler } from "hono";
import { forbidden } from "@/lib/errors";
import {
  consume,
  getMonthlyPeriod,
  tryConsumeAtomic,
} from "@/services/quotas.service";
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
    if (
      !entitlements ||
      typeof clinicId !== "number" ||
      !entitlements.features[feature]
    ) {
      return forbidden(c, "FEATURE_DISABLED", { feature });
    }

    const period = getMonthlyPeriod();
    const limit = entitlements.limits?.[feature];
    c.header("X-Quota-Period", period);
    if (typeof limit === "number") {
      // Atomic check-and-increment to avoid TOCTOU
      const { allowed, used: newUsed } = await tryConsumeAtomic(
        clinicId,
        feature,
        amount,
        limit
      );
      c.header("X-Quota-Limit", String(limit));
      c.header("X-Quota-Used", String(newUsed));
      c.header("X-Quota-Remaining", String(Math.max(limit - newUsed, 0)));
      if (!allowed && mode === "hard") {
        return forbidden(c, "QUOTA_EXCEEDED", {
          feature,
          limit,
          used: newUsed,
          period,
        });
      }
      // Soft mode: proceed even if not allowed
      await next();
      return;
    }

    // No limit configured → proceed and optionally count
    await next();
    if (c.res.status >= 200 && c.res.status < 400) {
      await consume(clinicId, feature, amount, period);
    }
  };
}
