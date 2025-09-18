import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.ts";
import {
  createClinic,
  getClinicById,
  getClinics,
} from "./clinics.controller.ts";

const router = new Hono<AppEnv>();

router.get("/", getClinics);

router.post("/", createClinic);

router.get("/:id", getClinicById);

export default router;
