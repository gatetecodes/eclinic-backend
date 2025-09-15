import { Hono } from "hono";
import * as ClinicsController from "./clinics.controller.ts";
import type { AppEnv } from "../../../middlewares/auth";

const router = new Hono<AppEnv>();

router.get("/", ClinicsController.getClinics);

router.post("/", ClinicsController.createClinic);

router.get("/:id", ClinicsController.getClinicById);

export default router;
