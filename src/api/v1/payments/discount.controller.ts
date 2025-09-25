import { ApprovalType, PaymentStatus } from "@prisma/client";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { db } from "../../../database/db";
import { httpCodes } from "../../../lib/constants";

export const createDiscount = async (c: Context) => {
  try {
    const user = c.get("user");
    const paymentId = Number(c.req.param("paymentId"));
    const { amount, reason } = c.get("validatedJson");
    const payment = await db.payment.findUnique({
      where: {
        id: paymentId,
      },
      select: {
        id: true,
        paymentStatus: true,
        patientAmount: true,
      },
    });
    if (!payment) {
      return c.json(
        { error: "Payment not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (payment.paymentStatus !== PaymentStatus.PENDING) {
      return c.json(
        { error: "Cannot apply discount to a non-pending payment" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    if (amount > Number(payment.patientAmount)) {
      return c.json(
        { error: "Discount amount cannot be greater than the patient amount" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const discountWithApproval = await db.$transaction(async (tx) => {
      const discount = await tx.discount.create({
        data: {
          amount,
          reason,
          clinicId: user.clinic.id,
          branchId: user.branch.id,
          paymentId,
          createdById: user.id,
        },
      });
      const approvalRequest = await tx.approval.create({
        data: {
          type: ApprovalType.DISCOUNT,
          clinicId: user.clinic.id,
          branchId: user.branch.id,
          requestedById: user.id,
          discountId: discount.id,
          reason,
        },
      });
      return { discount, approvalRequest };
    });

    return c.json(
      {
        success: "Discount created and pending approval",
        data: discountWithApproval,
      },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getDiscountsForPayment = async (c: Context) => {
  try {
    const paymentId = Number(c.req.param("paymentId"));
    const discounts = await db.discount.findMany({
      where: { paymentId },
      include: {
        approval: true,
      },
    });
    return c.json({ data: discounts }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
