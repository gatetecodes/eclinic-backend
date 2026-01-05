import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";
import {
  createClinic,
  getClinicById,
  getClinics,
  getPortalClinicDoctors,
  getPortalClinics,
  togglePatientPortalForClinic,
  updateClinic,
  updateClinicAdmin,
  updateClinicSettings,
  updateClinicSubscriptionStatus,
} from "./clinics.controller.ts";
import {
  clinicSchema,
  updateClinicAdminSchema,
  updateClinicSchema,
  updateClinicSubscriptionStatusSchema,
} from "./clinics.validation.ts";

const router = new Hono<AppEnv>();

router.get("/", getClinics);
router.get("/portal", getPortalClinics);
router.post("/", validate(clinicSchema, "json"), createClinic);

router.get("/:id", getClinicById);

router.put("/:id", validate(updateClinicSchema, "json"), updateClinic);

router.put(
  "/:id/admin",
  validate(updateClinicAdminSchema, "json"),
  updateClinicAdmin
);
router.get("/:id/doctors", getPortalClinicDoctors);
router.put("/:id/toggle-patient-portal", togglePatientPortalForClinic);
router.patch("/:id/settings", updateClinicSettings);

router.put(
  "/:id/subscription-status",
  validate(updateClinicSubscriptionStatusSchema, "json"),
  updateClinicSubscriptionStatus
);

export default router;
