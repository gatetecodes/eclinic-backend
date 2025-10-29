import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { crudAccess } from "../../../middlewares/crud-access.middleware.ts";
import { listPatients } from "./patients.controller.ts";

const router = new Hono<AppEnv>();
router.use("*", crudAccess("patients", "visits"));

router.get("/", listPatients);

export default router;
