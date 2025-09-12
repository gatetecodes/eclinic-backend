import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth";
import {
  logActivity,
  getVisitActivitiesTimeline,
} from "./activity.controller.ts";

const router = new Hono<AppEnv>();

router.post("/", logActivity);
router.get("/visits/:visitId/timeline", getVisitActivitiesTimeline);

export default router;
