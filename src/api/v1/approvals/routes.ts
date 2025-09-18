import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth";
import {
  createApprovalRequest,
  getApprovalRequests,
  processApprovalRequest,
} from "./approvals.controller.ts";

const router = new Hono<AppEnv>();

router.post("/", createApprovalRequest);
router.post("/:id/process", processApprovalRequest);
router.get("/", getApprovalRequests);

export default router;
