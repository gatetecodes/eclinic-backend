import { Hono } from "hono";
import { validate } from "@/middlewares/validation.middleware.ts";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { crudAccess } from "../../../middlewares/crud-access.middleware.ts";
import {
  getInsuranceClaims,
  markInsuranceClaimAsPaid,
  recordInsuranceDeduction,
} from "./insurance-claim.controller.ts";
import {
  markInsuranceClaimAsPaidSchema,
  recordInsuranceDeductionSchema,
} from "./insurance-claim.validation.ts";

const router = new Hono<AppEnv>();
router.use("*", crudAccess("insuranceClaims"));

router.get("/", getInsuranceClaims);
router.post(
  "/:claimId/mark-as-paid",
  validate(markInsuranceClaimAsPaidSchema, "json"),
  markInsuranceClaimAsPaid
);
router.post(
  "/:claimId/record-deduction",
  validate(recordInsuranceDeductionSchema, "json"),
  recordInsuranceDeduction
);

export default router;
