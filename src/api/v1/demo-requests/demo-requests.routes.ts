import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../../../middlewares/auth.middleware";
import { validate } from "../../../middlewares/validation.middleware";
import {
  approveDemoRequest,
  createDemoRequest,
  getDemoRequests,
  rejectDemoRequest,
} from "./demo-requests.controller";
import { demoRequestSchema } from "./demo-requests.validation";

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

const router = new Hono();
router.post("/", validate(demoRequestSchema, "json"), createDemoRequest);
router.get("/", requireAuth, getDemoRequests);
router.put(
  "/:id/approve",
  validate(idParamSchema, "param"),
  requireAuth,
  approveDemoRequest
);
router.put(
  "/:id/reject",
  validate(idParamSchema, "param"),
  requireAuth,
  rejectDemoRequest
);

export default router;
