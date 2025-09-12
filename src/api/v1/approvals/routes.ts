import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth";
import * as ApprovalsController from "./approvals.controller.ts";

const router = new Hono<AppEnv>();

router.post("/", ApprovalsController.createApprovalRequest);
router.post("/:id/process", ApprovalsController.processApprovalRequest);
router.get("/", ApprovalsController.getApprovalRequests);

export default router;
