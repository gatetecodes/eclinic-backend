import { Hono } from "hono";
import * as PaymentsController from "./payments.controller.ts";
import type { AppEnv } from "../../../middlewares/auth";

const router = new Hono<AppEnv>();

router.get("/", PaymentsController.listPayments);

export default router;
