import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";
import {
  createExam,
  createExamResult,
  createExamTest,
  getExamById,
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

// Exam routes
// Get all exams (with filtering and pagination)
router.get("/", getExams);

// Create a new exam
router.post("/", validate(createExamSchema, "json"), createExam);

// Get exam by ID
router.get("/:id", validate(getExamParamsSchema, "param"), getExamById);

// Update exam
router.put(
  "/:id",
  validate(getExamParamsSchema, "param"),
  validate(updateExamSchema, "json"),
  updateExam
);

// Get exams by visit ID
router.get(
  "/visit/:visitId",
  validate(getVisitIdParamsSchema, "param"),
  getExamsByVisitId
);

// Exam Results routes
// Get all exam results (with filtering and pagination)
router.get("/results", getExamResults);

// Create a new exam result
router.post(
  "/results",
  validate(createExamResultSchema, "json"),
  createExamResult
);

// Get exam result by ID
router.get(
  "/results/:id",
  validate(getExamResultParamsSchema, "param"),
  getExamResultById
);

// Update exam result
router.put(
  "/results/:id",
  validate(getExamResultParamsSchema, "param"),
  validate(updateExamResultSchema, "json"),
  updateExamResult
);

// Exam Tests routes
// Get all exam tests (with filtering and pagination)
router.get("/tests", getExamTests);

// Create a new exam test
router.post("/tests", validate(createExamTestSchema, "json"), createExamTest);

// Update exam test
router.put(
  "/tests/:id",
  validate(getExamTestParamsSchema, "param"),
  validate(updateExamTestSchema, "json"),
  updateExamTest
);

// Update exam test units
router.patch(
  "/tests/:id/units",
  validate(getExamTestParamsSchema, "param"),
  validate(updateExamTestUnitsSchema, "json"),
  updateExamTestUnits
);

// Update exam test normal range
router.patch(
  "/tests/:id/normal-range",
  validate(getExamTestParamsSchema, "param"),
  validate(updateExamTestNormalRangeSchema, "json"),
  updateExamTestNormalRange
);

// Update exam test consumables
router.patch(
  "/tests/:id/consumables",
  validate(getExamTestParamsSchema, "param"),
  validate(updateExamTestConsumablesSchema, "json"),
  updateExamTestConsumables
);

export default router;
