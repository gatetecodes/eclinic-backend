import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { crudAccess } from "../../../middlewares/crud-access.middleware.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";
import {
  createDiscount,
  getDiscountsForPayment,
} from "./discount.controller.ts";
import {
  exportPayments,
  getPayments,
  markPaymentAsPaid,
  requestExamRefundApproval,
} from "./payments.controller.ts";
import {
  createDiscountSchema,
  markPaymentAsPaidSchema,
  requestExamRefundApprovalSchema,
} from "./payments.validation.ts";

const router = new Hono<AppEnv>();
router.use("*", crudAccess("payments"));

router.get("/", getPayments);
router.get("/export", exportPayments);
router.get("/:paymentId/discounts", getDiscountsForPayment);
router.post(
  "/:paymentId/discounts",
  validate(createDiscountSchema, "json"),
  createDiscount
);
router.post(
  "/:paymentId/mark-as-paid",
  validate(markPaymentAsPaidSchema, "json"),
  markPaymentAsPaid
);
router.post(
  "/:paymentId/request-refund",
  validate(requestExamRefundApprovalSchema, "json"),
  requestExamRefundApproval
);

export default router;
