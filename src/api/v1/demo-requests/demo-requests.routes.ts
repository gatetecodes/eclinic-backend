import { Hono } from "hono";
import { validate } from "../../../middlewares/validation.middleware";
import {
  approveDemoRequest,
  createDemoRequest,
  getDemoRequests,
  rejectDemoRequest,
} from "./demo-requests.controller";
import { demoRequestSchema } from "./demo-requests.validation";

const router = new Hono();
router.post("/", validate(demoRequestSchema, "json"), createDemoRequest);
router.get("/", getDemoRequests);
router.put("/:id/approve", approveDemoRequest);
router.put("/:id/reject", rejectDemoRequest);

export default router;
