import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth";
import { listPayments } from "./payments.controller.ts";

const router = new Hono<AppEnv>();

router.get("/", listPayments);

export default router;
