import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth";
import * as PatientsController from "./patients.controller.ts";

const router = new Hono<AppEnv>();

router.get("/", PatientsController.listPatients);

export default router;
