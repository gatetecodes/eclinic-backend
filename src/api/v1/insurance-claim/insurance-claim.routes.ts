import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.ts";
import { crudAccess } from "../../../middlewares/crud-access";
import { getInsuranceClaims } from "./insurance-claim.controller.ts";

const router = new Hono<AppEnv>();
router.use("*", crudAccess("insuranceClaims"));

router.get("/", getInsuranceClaims);

export default router;
