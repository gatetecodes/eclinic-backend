import { Hono } from "hono";
import { validate } from "@/middlewares/validation.middleware.ts";
import { withAccess } from "@/middlewares/with-access.middleware.ts";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { crudAccess } from "../../../middlewares/crud-access.middleware.ts";
import {
  addDoctorAvailability,
  assignDepartmentsToDoctor,
  deactivateUser,
  editDoctor,
  editUser,
  getAllBranchDoctors,
  getAllClinicDoctors,
  getAvailableDoctorsByDepartmentId,
  getCashiers,
  getClinicDoctors,
  getClinicUsers,
  getDoctorsByDepartmentId,
  getUserById,
} from "./users.controller.ts";
import {
  addDoctorAvailabilitySchema,
  assignDepartmentsToDoctorSchema,
  getAvailableDoctorsByDepartmentIdSchema,
} from "./users.validation.ts";

const router = new Hono<AppEnv>();

router.get("/clinic", crudAccess("users"), getClinicUsers);
router.get("/clinic/doctors", crudAccess("users"), getClinicDoctors);
router.get("/branch/doctors", crudAccess("users"), getAllBranchDoctors);
router.get("/doctors", crudAccess("users"), getAllClinicDoctors);
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
router.post(
  "/:userId/deactivate",
  ...withAccess({ resource: "users", action: "update", feature: "users" }),
  deactivateUser
);
router.put("/:userId", crudAccess("users"), editUser);
router.put("/doctors/:doctorId", crudAccess("users"), editDoctor);
router.get("/:userId", crudAccess("users"), getUserById);

export default router;
