import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";
import {
  createDiscount,
  getDiscountsForPayment,
} from "./discount.controller.ts";
import {
  exportPayments,
  getPayments,
  markPaymentAsPaid,
} from "./payments.controller.ts";
import { markPaymentAsPaidSchema } from "./payments.validation.ts";

const router = new Hono<AppEnv>();

router.get("/", getPayments);
router.get("/export", exportPayments);
router.get("/:paymentId/discounts", getDiscountsForPayment);
router.post("/:paymentId/discounts", createDiscount);
router.post(
  "/:paymentId/mark-as-paid",
  validate(markPaymentAsPaidSchema, "json"),
  markPaymentAsPaid
);

export default router;
