import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth";
import { getVisitById, listVisits } from "./visits.controller.ts";

const router = new Hono<AppEnv>();

router.get("/", listVisits);
router.get("/:id", getVisitById);

export default router;
