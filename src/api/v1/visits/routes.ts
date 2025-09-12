import { Hono } from "hono";
import * as VisitsController from "./visits.controller.ts";
import type { AppEnv } from "../../../middlewares/auth";

const router = new Hono<AppEnv>();

router.get("/", VisitsController.listVisits);
router.get("/:id", VisitsController.getVisitById);

export default router;
