import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.ts";
import { getInsuranceClaims } from "./insurance-claim.controller.ts";

const router = new Hono<AppEnv>();

router.get("/", getInsuranceClaims);

export default router;
