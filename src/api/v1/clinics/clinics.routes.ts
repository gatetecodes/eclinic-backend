import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";
import {
  createClinic,
  getClinicById,
  getClinics,
  updateClinic,
  updateClinicAdmin,
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

router.post("/", validate(clinicSchema, "json"), createClinic);

router.get("/:id", getClinicById);

router.put("/:id", validate(updateClinicSchema, "json"), updateClinic);

router.put(
  "/:id/admin",
  validate(updateClinicAdminSchema, "json"),
  updateClinicAdmin
);

router.put(
  "/:id/subscription-status",
  validate(updateClinicSubscriptionStatusSchema, "json"),
  updateClinicSubscriptionStatus
);

export default router;
