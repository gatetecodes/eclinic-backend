import { Hono } from "hono";
import { z } from "zod";
import {
  requireAuth,
  requireSuperAdmin,
} from "../../../middlewares/auth.middleware";
import { verifyRecaptcha } from "../../../middlewares/recaptcha.middleware";
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
router.post(
  "/",
  verifyRecaptcha({ expectedAction: "eclinic_demo_request" }),
  validate(demoRequestSchema, "json"),
  createDemoRequest
);
// Operator-only: this segment mounts before the global auth middleware, so we
// chain requireAuth → requireSuperAdmin inline (previously only requireAuth,
// which let any logged-in user list/approve demo requests).
router.get("/", requireAuth, requireSuperAdmin, getDemoRequests);
router.put(
  "/:id/approve",
  validate(idParamSchema, "param"),
  requireAuth,
  requireSuperAdmin,
  approveDemoRequest
);
router.put(
  "/:id/reject",
  validate(idParamSchema, "param"),
  requireAuth,
  requireSuperAdmin,
  rejectDemoRequest
);

export default router;
