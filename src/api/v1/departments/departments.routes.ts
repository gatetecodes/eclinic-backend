import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";
import {
  createClinicDepartments,
  createDepartment,
  deleteDepartment,
  getClinicalDepartmentsList,
  getDepartmentById,
  getDepartments,
  getDepartmentsByClinicId,
  updateDepartment,
} from "./departments.controller.ts";
import {
  createClinicDepartmentsSchema,
  createDepartmentSchema,
  getClinicIdParamsSchema,
  getDepartmentParamsSchema,
  updateDepartmentSchema,
} from "./departments.validation.ts";

const router = new Hono<AppEnv>();

// Get all departments (with filtering and pagination)
router.get("/", getDepartments);

// Create a new department
router.post("/", validate(createDepartmentSchema, "json"), createDepartment);

// Get department by ID
router.get(
  "/:id",
  validate(getDepartmentParamsSchema, "param"),
  getDepartmentById
);

// Update department
router.put(
  "/:id",
  validate(getDepartmentParamsSchema, "param"),
  validate(updateDepartmentSchema, "json"),
  updateDepartment
);

// Delete department
router.delete(
  "/:id",
  validate(getDepartmentParamsSchema, "param"),
  deleteDepartment
);

// Create clinic departments (connect existing departments to clinic)
router.post(
  "/clinic",
  validate(createClinicDepartmentsSchema, "json"),
  createClinicDepartments
);

// Get clinical departments list (for dropdowns/selection)
router.get("/list/clinical", getClinicalDepartmentsList);

// Get departments by clinic ID
router.get(
  "/clinic/:clinicId",
  validate(getClinicIdParamsSchema, "param"),
  getDepartmentsByClinicId
);

export default router;
