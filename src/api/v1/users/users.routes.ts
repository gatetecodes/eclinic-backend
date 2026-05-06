import { Hono } from "hono";
import { validate } from "@/middlewares/validation.middleware.ts";
import { withAccess } from "@/middlewares/with-access.middleware.ts";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { crudAccess } from "../../../middlewares/crud-access.middleware.ts";
import {
  addDoctorAvailability,
  addNewUser,
  assignDepartmentsToDoctor,
  createDoctor,
  deactivateUser,
  editDoctor,
  editUser,
  getAllBranchDoctors,
  getAllClinicDoctors,
  getAvailableDoctorsByDepartmentId,
  getCashiers,
  getClinicDoctors,
  getClinicNurses,
  getClinicTimesheets,
  getClinicUsers,
  getCurrentUser,
  getDoctorsByDepartmentId,
  getExpiringTimesheetsCount,
  getStaffWithoutTimesheets,
  getUserById,
  getUserTimesheet,
  updateMyLocalePreference,
  upsertUserTimesheet,
} from "./users.controller.ts";
import {
  addDoctorAvailabilitySchema,
  assignDepartmentsToDoctorSchema,
  createDoctorSchema,
  createUserSchema,
  editDoctorSchema,
  getAvailableDoctorsByDepartmentIdSchema,
  updateLocalePreferenceSchema,
  updateUserSchema,
  upsertTimesheetSchema,
} from "./users.validation.ts";

const router = new Hono<AppEnv>();

router.post(
  "/",
  crudAccess("users"),
  validate(createUserSchema, "json"),
  addNewUser
);
router.post(
  "/doctors",
  crudAccess("users"),
  validate(createDoctorSchema, "json"),
  createDoctor
);
router.get("/clinic", crudAccess("users"), getClinicUsers);
router.get("/clinic/doctors", crudAccess("users"), getClinicDoctors);
router.get("/clinic/timesheets", crudAccess("users"), getClinicTimesheets);
router.get(
  "/clinic/timesheets/expiring-count",
  crudAccess("users"),
  getExpiringTimesheetsCount
);
router.get(
  "/clinic/staff/without-timesheets",
  crudAccess("users"),
  getStaffWithoutTimesheets
);
router.get("/branch/doctors", crudAccess("users"), getAllBranchDoctors);
router.get("/doctors", crudAccess("users"), getAllClinicDoctors);
router.get("/clinic/nurses", crudAccess("users"), getClinicNurses);
router.get("/cashiers", crudAccess("users"), getCashiers);
router.get(
  "/department/:departmentId/doctors",
  crudAccess("users"),
  getDoctorsByDepartmentId
);
router.post(
  "/doctors/available-by-department",
  validate(getAvailableDoctorsByDepartmentIdSchema, "json"),
  ...withAccess({ resource: "users", action: "read", feature: "users" }),
  getAvailableDoctorsByDepartmentId
);
router.put(
  "/:id/availability",
  crudAccess("users"),
  validate(addDoctorAvailabilitySchema, "json"),
  addDoctorAvailability
);
router.put(
  "/:id/departments",
  crudAccess("users"),
  validate(assignDepartmentsToDoctorSchema, "json"),
  assignDepartmentsToDoctor
);
router.get("/:id/timesheet", crudAccess("users"), getUserTimesheet);
router.get("/me", crudAccess("users"), getCurrentUser);
router.put(
  "/me/preferences",
  validate(updateLocalePreferenceSchema, "json"),
  updateMyLocalePreference
);
router.put(
  "/:id/timesheet",
  crudAccess("users"),
  validate(upsertTimesheetSchema, "json"),
  upsertUserTimesheet
);
router.post(
  "/:userId/deactivate",
  ...withAccess({ resource: "users", action: "update", feature: "users" }),
  deactivateUser
);
router.put(
  "/:userId",
  crudAccess("users"),
  validate(updateUserSchema, "json"),
  editUser
);
router.put(
  "/doctors/:doctorId",
  crudAccess("users"),
  validate(editDoctorSchema, "json"),
  editDoctor
);
router.get("/:userId", crudAccess("users"), getUserById);

export default router;
