import { Hono } from "hono";
import {
  addNewUser,
  createDoctor,
  deactivateUser,
  editDoctor,
  editUser,
  getAllBranchDoctors,
  getAllClinicDoctors,
  getCashiers,
  getClinicDoctors,
  getClinicUsers,
  getDoctorsByDepartmentId,
} from "./users.controller.ts";

const router = new Hono();

router.get("/clinic", getClinicUsers);
router.get("/clinic/doctors", getClinicDoctors);
router.get("/branch/doctors", getAllBranchDoctors);
router.get("/doctors", getAllClinicDoctors);
router.get("/cashiers", getCashiers);
router.get("/department/:departmentId/doctors", getDoctorsByDepartmentId);
router.post("/", addNewUser);
router.post("/doctors", createDoctor);
router.post("/:userId/deactivate", deactivateUser);
router.put("/:userId", editUser);
router.put("/doctors/:doctorId", editDoctor);

export default router;
