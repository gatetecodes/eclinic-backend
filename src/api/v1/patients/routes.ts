import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth";
import { crudAccess } from "../../../middlewares/crud-access";
import { listPatients } from "./patients.controller.ts";

const router = new Hono<AppEnv>();
router.use("*", crudAccess("patients", "visits"));

router.get("/", listPatients);

export default router;
