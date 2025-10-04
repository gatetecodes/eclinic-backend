import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { requireQuota } from "../../../middlewares/quota.middleware.ts";
import { withAccess } from "../../../middlewares/with-access.middleware.ts";
import {
  countVisitsByDepartments,
  getCashFlow,
  getClinicGrowthData,
  getClinicsOverview,
  getClinicsRevenue,
  getDashboard,
  getDashboardOverview,
  getPatientsByAge,
  getTopPerformingClinics,
} from "./analytics.controller.ts";

const router = new Hono<AppEnv>();

router.get(
  "/dashboard",
  ...withAccess({ resource: "analytics", action: "read" }),
  getDashboard
);
router.get(
  "/dashboard-overview",
  ...withAccess({ resource: "analytics", action: "read" }),
  getDashboardOverview
);
router.get(
  "/patients-by-age",
  ...withAccess({ resource: "analytics", action: "read" }),
  getPatientsByAge
);
router.get(
  "/cash-flow",
  ...withAccess({
    resource: "analytics",
    action: "read",
    feature: "analyticsPro",
  }),
  requireQuota("analyticsPro", 1, "soft"),
  getCashFlow
);
router.get(
  "/visits-by-departments",
  ...withAccess({ resource: "analytics", action: "read" }),
  countVisitsByDepartments
);
router.get(
  "/platform/overview",
  ...withAccess({ resource: "analytics", action: "read" }),
  getClinicsOverview
);

router.get(
  "/platform/growth",
  ...withAccess({
    resource: "analytics",
    action: "read",
    feature: "analyticsPro",
  }),
  requireQuota("analyticsPro", 1, "soft"),
  getClinicGrowthData
);
router.get(
  "/platform/top",
  ...withAccess({
    resource: "analytics",
    action: "read",
    feature: "analyticsPro",
  }),
  requireQuota("analyticsPro", 1, "soft"),
  getTopPerformingClinics
);
router.get(
  "/platform/revenue",
  ...withAccess({
    resource: "analytics",
    action: "read",
    feature: "analyticsPro",
  }),
  requireQuota("analyticsPro", 1, "soft"),
  getClinicsRevenue
);

export default router;
