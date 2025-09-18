import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth";
import {
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

router.get("/dashboard", getDashboard);
router.get("/dashboard-overview", getDashboardOverview);
router.get("/patients-by-age", getPatientsByAge);
router.get("/cash-flow", getCashFlow);
router.get("/platform/overview", getClinicsOverview);
router.get("/platform/growth", getClinicGrowthData);
router.get("/platform/top", getTopPerformingClinics);
router.get("/platform/revenue", getClinicsRevenue);

export default router;
