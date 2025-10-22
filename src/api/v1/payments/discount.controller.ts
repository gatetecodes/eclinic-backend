import { ApprovalType, PaymentStatus } from "@prisma/client";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { invalidatePaymentRelatedCaches } from "@/lib/cache-utils";
import { db } from "../../../database/db";
import { httpCodes } from "../../../lib/constants";

export const createDiscount = async (c: Context) => {
  try {
    const user = c.get("user");
    if (!user) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    const paymentIdRaw = c.req.param("paymentId");
    const paymentId = Number.parseInt(paymentIdRaw, 10);
    const body = c.get("validatedJson") as
      | { amount: number; reason: string }
      | undefined;

    if (!Number.isFinite(paymentId) || paymentId <= 0) {
      return c.json(
        { error: "Invalid paymentId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    if (!body) {
      return c.json(
        { error: "Request body is invalid or not validated" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const { amount, reason } = body;

    const payment = await db.payment.findUnique({
      where: {
        id: paymentId,
      },
      select: {
        id: true,
        visitId: true,
        paymentStatus: true,
        patientAmount: true,
        clinicId: true,
        branchId: true,
      },
    });
    if (!payment) {
      return c.json(
        { error: "Payment not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (
      payment.clinicId !== user.clinicId ||
      payment.branchId !== user.branchId
    ) {
      return c.json(
        { error: "Forbidden: you cannot act on this payment" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    if (payment.paymentStatus !== PaymentStatus.PENDING) {
      return c.json(
        { error: "Cannot apply discount to a non-pending payment" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    if (amount <= 0) {
      return c.json(
        { error: "Discount amount must be greater than 0" },
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
          clinicId: user.clinicId,
          branchId: user.branchId,
          paymentId,
          createdById: Number(user.id),
        },
      });
      const approvalRequest = await tx.approval.create({
        data: {
          type: ApprovalType.DISCOUNT,
          clinicId: user.clinicId,
          branchId: user.branchId,
          requestedById: Number(user.id),
          discountId: discount.id,
          reason,
        },
      });
      return { discount, approvalRequest };
    });

    await invalidatePaymentRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId: payment.visitId ?? undefined,
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
    const user = c.get("user");
    if (!user) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    const paymentIdRaw = c.req.param("paymentId");
    const paymentId = Number.parseInt(paymentIdRaw, 10);
    if (!Number.isFinite(paymentId) || paymentId <= 0) {
      return c.json(
        { error: "Invalid paymentId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const payment = await db.payment.findUnique({
      where: { id: paymentId },
      select: { id: true, clinicId: true, branchId: true },
    });
    if (!payment) {
      return c.json(
        { error: "Payment not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (
      payment.clinicId !== user.clinicId ||
      payment.branchId !== user.branchId
    ) {
      return c.json(
        { error: "Forbidden: you cannot act on this payment" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    const discounts = await db.discount.findMany({
      where: { paymentId },
      include: { approval: true },
    });
    return c.json({ data: discounts }, httpCodes.OK as ContentfulStatusCode);
  } catch {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
