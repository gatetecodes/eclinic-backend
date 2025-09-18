import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth";
import { listPatients } from "./patients.controller.ts";

const router = new Hono<AppEnv>();

router.get("/", listPatients);

export default router;
