import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";
import { withAccess } from "../../../middlewares/with-access.middleware.ts";
import {
  bulkUpdateExamTests,
  createExam,
  createExamResult,
  createExamTest,
  getExamById,
  getExamConsumption,
  getExamConsumptionDetails,
  getExamResultById,
  getExamResults,
  getExams,
  getExamsByVisitId,
  getExamTests,
  updateExam,
  updateExamResult,
  updateExamTest,
  updateExamTestConsumables,
  updateExamTestNormalRange,
  updateExamTestUnits,
} from "./exams.controller.ts";
import {
  bulkUpdateExamTestsSchema,
  createExamResultSchema,
  createExamSchema,
  createExamTestSchema,
  getExamParamsSchema,
  getExamResultParamsSchema,
  getExamTestParamsSchema,
  getVisitIdParamsSchema,
  updateExamResultSchema,
  updateExamSchema,
  updateExamTestConsumablesSchema,
  updateExamTestNormalRangeSchema,
  updateExamTestSchema,
  updateExamTestUnitsSchema,
} from "./exams.validation.ts";

const router = new Hono<AppEnv>();

// Consumption routes
router.get(
  "/consumption",
  ...withAccess({ resource: "exams", action: "read", feature: "lab" }),
  getExamConsumption
);

router.get(
  "/consumption/:examName/visits",
  ...withAccess({ resource: "exams", action: "read", feature: "lab" }),
  getExamConsumptionDetails
);

// Exam Results routes
// Get all exam results (with filtering and pagination)
router.get(
  "/results",
  ...withAccess({ resource: "exams", action: "read", feature: "lab" }),
  getExamResults
);

// Create a new exam result
router.post(
  "/results",
  ...withAccess({ resource: "exams", action: "create", feature: "lab" }),
  validate(createExamResultSchema, "json"),
  createExamResult
);

// Get exam result by ID
router.get(
  "/results/:id",
  validate(getExamResultParamsSchema, "param"),
  ...withAccess({ resource: "exams", action: "read", feature: "lab" }),
  getExamResultById
);

// Update exam result
router.put(
  "/results/:id",
  validate(getExamResultParamsSchema, "param"),
  validate(updateExamResultSchema, "json"),
  ...withAccess({ resource: "exams", action: "update", feature: "lab" }),
  updateExamResult
);

// Exam Tests routes
// Get all exam tests (with filtering and pagination)
router.get(
  "/tests",
  ...withAccess({ resource: "exams", action: "read", feature: "lab" }),
  getExamTests
);

// Create a new exam test
router.post(
  "/tests",
  ...withAccess({ resource: "exams", action: "create", feature: "lab" }),
  validate(createExamTestSchema, "json"),
  createExamTest
);

// Batch-update exam tests (Tests Management screen "Save changes").
// Registered before "/tests/:id" so "bulk" is never parsed as an id.
router.patch(
  "/tests/bulk",
  validate(bulkUpdateExamTestsSchema, "json"),
  ...withAccess({ resource: "exams", action: "update", feature: "lab" }),
  bulkUpdateExamTests
);

// Update exam test
router.put(
  "/tests/:id",
  validate(getExamTestParamsSchema, "param"),
  validate(updateExamTestSchema, "json"),
  ...withAccess({ resource: "exams", action: "update", feature: "lab" }),
  updateExamTest
);

// Update exam test units
router.patch(
  "/tests/:id/units",
  validate(getExamTestParamsSchema, "param"),
  validate(updateExamTestUnitsSchema, "json"),
  ...withAccess({ resource: "exams", action: "update", feature: "lab" }),
  updateExamTestUnits
);

// Update exam test normal range
router.patch(
  "/tests/:id/normal-range",
  validate(getExamTestParamsSchema, "param"),
  validate(updateExamTestNormalRangeSchema, "json"),
  ...withAccess({ resource: "exams", action: "update", feature: "lab" }),
  updateExamTestNormalRange
);

// Update exam test consumables
router.patch(
  "/tests/:id/consumables",
  validate(getExamTestParamsSchema, "param"),
  validate(updateExamTestConsumablesSchema, "json"),
  ...withAccess({ resource: "exams", action: "update", feature: "lab" }),
  updateExamTestConsumables
);

// Exam routes
// Get all exams (with filtering and pagination)
router.get(
  "/",
  ...withAccess({ resource: "exams", action: "read", feature: "lab" }),
  getExams
);

// Create a new exam
router.post(
  "/",
  ...withAccess({ resource: "exams", action: "create", feature: "lab" }),
  validate(createExamSchema, "json"),
  createExam
);

// Get exam by ID
router.get(
  "/:id",
  validate(getExamParamsSchema, "param"),
  ...withAccess({ resource: "exams", action: "read", feature: "lab" }),
  getExamById
);

// Update exam
router.put(
  "/:id",
  validate(getExamParamsSchema, "param"),
  validate(updateExamSchema, "json"),
  ...withAccess({ resource: "exams", action: "update", feature: "lab" }),
  updateExam
);

// Get exams by visit ID
router.get(
  "/visit/:visitId",
  validate(getVisitIdParamsSchema, "param"),
  ...withAccess({ resource: "exams", action: "read", feature: "lab" }),
  getExamsByVisitId
);

export default router;
