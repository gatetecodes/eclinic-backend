import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { crudAccess } from "../../../middlewares/crud-access.middleware.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";
import {
  assignDepartmentsToClinic,
  createClinicDepartments,
  createDepartment,
  deleteDepartment,
  getAllClinicDepartments,
  getClinicalDepartmentsList,
  getDepartmentById,
  getDepartments,
  getDepartmentsByClinicId,
  getDepartmentsList,
  updateDepartment,
} from "./departments.controller.ts";
import {
  assignDepartmentsToClinicSchema,
  createClinicDepartmentsSchema,
  createDepartmentSchema,
  getClinicIdParamsSchema,
  getDepartmentParamsSchema,
  updateDepartmentSchema,
} from "./departments.validation.ts";

const router = new Hono<AppEnv>();
router.use("*", crudAccess("departments", "visits"));

// Get all departments (with filtering and pagination)
router.get("/", getDepartments);

// Get all clinic departments (with filtering and pagination)
router.get("/clinic", getAllClinicDepartments);

// Get departments list (for dropdowns/selection)
router.get("/list", getDepartmentsList);

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

// Assign departments to clinic
router.put(
  "/clinic/:clinicId/assign",
  validate(getClinicIdParamsSchema, "param"),
  validate(assignDepartmentsToClinicSchema, "json"),
  assignDepartmentsToClinic
);

export default router;
