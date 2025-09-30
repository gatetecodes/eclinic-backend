import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { crudAccess } from "../../../middlewares/crud-access.middleware.ts";
import { getInsuranceClaims } from "./insurance-claim.controller.ts";

const router = new Hono<AppEnv>();
router.use("*", crudAccess("insuranceClaims"));

router.get("/", getInsuranceClaims);

export default router;
