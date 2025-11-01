import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { requireQuota } from "../../../middlewares/quota.middleware.ts";
import { withAccess } from "../../../middlewares/with-access.middleware.ts";
import {
  countVisitsByDepartments,
  getAccountantStats,
  getCashFlow,
  getClinicGrowthData,
  getClinicsOverview,
  getClinicsRevenue,
  getConversionRate,
  getCustomerSuccess,
  getDashboard,
  getDashboardOverview,
  getDoctorStats,
  getImportantStatusesVisitsCount,
  getLabTechnicianStats,
  getNurseStats,
  getPatientsByAge,
  getRevenueGrowth,
  getStockManagerStats,
  getTopPerformingClinics,
  getVisitGrowth,
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
router.get(
  "/platform/visit-growth",
  ...withAccess({
    resource: "analytics",
    action: "read",
    feature: "analyticsPro",
  }),
  requireQuota("analyticsPro", 1, "soft"),
  getVisitGrowth
);
router.get(
  "/platform/revenue-growth",
  ...withAccess({
    resource: "analytics",
    action: "read",
    feature: "analyticsPro",
  }),
  requireQuota("analyticsPro", 1, "soft"),
  getRevenueGrowth
);
router.get(
  "/platform/conversion-rate",
  ...withAccess({
    resource: "analytics",
    action: "read",
    feature: "analyticsPro",
  }),
  requireQuota("analyticsPro", 1, "soft"),
  getConversionRate
);
router.get(
  "/platform/customer-success",
  ...withAccess({
    resource: "analytics",
    action: "read",
    feature: "analyticsPro",
  }),
  requireQuota("analyticsPro", 1, "soft"),
  getCustomerSuccess
);
router.get(
  "/stock-manager/stats",
  ...withAccess({ resource: "analytics", action: "read" }),
  getStockManagerStats
);

router.get(
  "/lab-technician/stats",
  ...withAccess({ resource: "analytics", action: "read" }),
  getLabTechnicianStats
);

router.get(
  "/accountant/stats",
  ...withAccess({ resource: "analytics", action: "read" }),
  getAccountantStats
);

router.get(
  "/doctor/stats",
  ...withAccess({ resource: "analytics", action: "read" }),
  getDoctorStats
);

router.get(
  "/nurse/stats",
  ...withAccess({ resource: "analytics", action: "read" }),
  getNurseStats
);

router.get(
  "/important-statuses-visits-count",
  ...withAccess({ resource: "analytics", action: "read" }),
  getImportantStatusesVisitsCount
);

export default router;
