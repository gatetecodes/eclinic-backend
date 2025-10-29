import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { requireAdmin } from "../../../middlewares/auth.middleware.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";
import {
  getClinicEntitlementOverrides,
  getClinicEntitlements,
  getEntitlementUsageSummary,
  getStats,
  upsertClinicEntitlementOverrides,
} from "./admin.controller.ts";

const router = new Hono<AppEnv>();

router.use("*", requireAdmin);
router.get("/stats", getStats);

const overridesSchema = z.object({
  overrides: z
    .array(
      z.object({
        featureKey: z.string(),
        allowed: z.boolean().optional(),
        limit: z.number().int().min(0).optional(),
        notes: z.string().optional(),
      })
    )
    .min(1),
});

router.get("/entitlements/usage/summary", getEntitlementUsageSummary);

router.get("/clinics/:id/entitlements", getClinicEntitlements);

router.get(
  "/clinics/:id/entitlements/overrides",
  getClinicEntitlementOverrides
);

router.put(
  "/clinics/:id/entitlements/overrides",
  validate(overridesSchema, "json"),
  upsertClinicEntitlementOverrides
);

export default router;
