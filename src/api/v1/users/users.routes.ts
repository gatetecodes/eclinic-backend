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
} from "./users.controller.ts";
import {
  addDoctorAvailabilitySchema,
  assignDepartmentsToDoctorSchema,
} from "./users.validation.ts";

const router = new Hono<AppEnv>();

router.use("*", crudAccess("users"));

router.get("/clinic", getClinicUsers);
router.get("/clinic/doctors", getClinicDoctors);
router.get("/branch/doctors", getAllBranchDoctors);
router.get("/doctors", getAllClinicDoctors);
router.get("/cashiers", getCashiers);
router.get("/department/:departmentId/doctors", getDoctorsByDepartmentId);
router.get(
  "/department/:departmentId/doctors/available",
  getAvailableDoctorsByDepartmentId
);
router.put(
  "/:id/availability",
  validate(addDoctorAvailabilitySchema, "json"),
  addDoctorAvailability
);
router.put(
  "/:id/departments",
  validate(assignDepartmentsToDoctorSchema, "json"),
  assignDepartmentsToDoctor
);
router.post(
  "/:userId/deactivate",
  ...withAccess({ resource: "users", action: "update", feature: "users" }),
  deactivateUser
);
router.put("/:userId", editUser);
router.put("/doctors/:doctorId", editDoctor);

export default router;
