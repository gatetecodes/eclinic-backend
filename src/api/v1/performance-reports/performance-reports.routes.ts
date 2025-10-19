import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { crudAccess } from "../../../middlewares/crud-access.middleware.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";
import {
  exportPerformanceData,
  getDetailedExams,
  getDetailedPayments,
  getDetailedTreatments,
  getDetailedVisits,
  getDoctorPerformanceMetrics,
  getPerformanceChartData,
  getPerformanceFilterData,
  getPerformanceOverview,
  getStaffDetailedActivities,
  getStaffPerformanceMetrics,
  getTopPerformers,
} from "./performance-reports.controller.ts";
import {
  detailedExamsSchema,
  detailedVisitsSchema,
  getTopPerformersSchema,
  rangeAndFiltersSchema,
} from "./performance-reports.validation.ts";

const router = new Hono<AppEnv>();
router.use("*", crudAccess("performanceReports"));

router.get(
  "/overview",
  validate(rangeAndFiltersSchema, "query"),
  getPerformanceOverview
);
router.get(
  "/doctor-performance",
  validate(rangeAndFiltersSchema, "query"),
  getDoctorPerformanceMetrics
);
router.get(
  "/staff-performance",
  validate(rangeAndFiltersSchema, "query"),
  getStaffPerformanceMetrics
);
router.get(
  "/detailed-visits",
  validate(detailedVisitsSchema, "query"),
  getDetailedVisits
);
router.get(
  "/export",
  validate(rangeAndFiltersSchema, "query"),
  exportPerformanceData
);
router.get(
  "/detailed-exams",
  validate(detailedExamsSchema, "query"),
  getDetailedExams
);
router.get(
  "/detailed-payments",
  validate(detailedExamsSchema, "query"),
  getDetailedPayments
);

router.get(
  "/performance-chart",
  validate(rangeAndFiltersSchema, "query"),
  getPerformanceChartData
);
router.get(
  "/top-performers",
  validate(getTopPerformersSchema, "query"),
  getTopPerformers
);
router.get(
  "/staff-detailed-activities",
  validate(detailedExamsSchema, "query"),
  getStaffDetailedActivities
);
router.get(
  "/detailed-treatments",
  validate(detailedExamsSchema, "query"),
  getDetailedTreatments
);
router.get("/filter-data", getPerformanceFilterData);
export default router;
