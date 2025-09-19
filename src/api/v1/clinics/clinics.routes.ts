import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";
import {
  createClinic,
  getClinicById,
  getClinics,
} from "./clinics.controller.ts";
import { clinicSchema } from "./clinics.validation.ts";

const router = new Hono<AppEnv>();

router.get("/", getClinics);

router.post("/", validate(clinicSchema, "json"), createClinic);

router.get("/:id", getClinicById);

export default router;
