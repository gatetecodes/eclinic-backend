import { Hono } from "hono";
import * as AnalyticsController from "./analytics.controller.ts";
import type { AppEnv } from "../../../middlewares/auth";

const router = new Hono<AppEnv>();

router.get("/dashboard", AnalyticsController.getDashboard);
router.get("/dashboard-overview", AnalyticsController.getDashboardOverview);
router.get("/patients-by-age", AnalyticsController.getPatientsByAge);
router.get("/cash-flow", AnalyticsController.getCashFlow);
router.get("/platform/overview", AnalyticsController.getClinicsOverview);
router.get("/platform/growth", AnalyticsController.getClinicGrowthData);
router.get("/platform/top", AnalyticsController.getTopPerformingClinics);
router.get("/platform/revenue", AnalyticsController.getClinicsRevenue);

export default router;
