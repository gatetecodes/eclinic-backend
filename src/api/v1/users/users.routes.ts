import { Hono } from "hono";
import { withAccess } from "@/middlewares/with-access.ts";
import type { AppEnv } from "../../../middlewares/auth.ts";
import { crudAccess } from "../../../middlewares/crud-access.ts";
import {
  addNewUser,
  createDoctor,
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
router.post("/", addNewUser);
router.post("/doctors", createDoctor);
router.post(
  "/:userId/deactivate",
  ...withAccess({ resource: "users", action: "update", feature: "users" }),
  deactivateUser
);
router.put("/:userId", editUser);
router.put("/doctors/:doctorId", editDoctor);

export default router;
