import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  type Payment,
  PaymentStatus,
  PaymentType,
  type Prisma,
} from "../../../../generated/prisma/client";
import { db } from "../../../database/db";
import {
  buildPaymentSuccessMessage,
  calculatePaymentTotals,
  findPaymentById,
  handlePostPaymentEffects,
  recordPaymentTransaction,
  validatePaymentAmountInput,
} from "../../../helpers/payments.helper";
import { buildQueryOptions } from "../../../helpers/query-helper";
import type { PaymentDetailLike } from "../../../helpers/refund-helpers";
import { buildRefundApprovalPayload } from "../../../helpers/refund-workflow";
import { searchParamsSchema } from "../../../lib/common-validation";
import { httpCodes } from "../../../lib/constants";
import { getScope } from "../../../lib/request-scope";
import {
  DEFAULT_CACHE_TTL,
  getCachedData,
} from "../../../services/redis.service";

export const getPayments = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId, branchId } = getScope(user, params);
    const queryOptions = buildQueryOptions<Payment>(params, {
      ...(typeof clinicId === "number" ? { clinicId } : {}),
      ...(typeof branchId === "number" ? { branchId } : {}),
    });
    const { where, orderBy, ...restOptions } = queryOptions;
    const cacheKey = `payments:${clinicId ?? "ALL"}:${branchId ?? "ALL"}:${JSON.stringify(params || {})}`;

    const paymentsData = await getCachedData(
      cacheKey,
      async () => {
        const payments = await db.payment.findMany({
          where: {
            ...where,
          } as Prisma.PaymentWhereInput,
          orderBy: orderBy as Prisma.PaymentOrderByWithRelationInput,
          ...restOptions,
          select: {
            id: true,
            amount: true,
            insuranceAmount: true,
            patientAmount: true,
            paymentDetails: true,
            paymentType: true,
            paymentStatus: true,
            paymentMethod: true,
            paymentMode: true,
            paidAmount: true,
            allowPartial: true,
            updatedAt: true,
            refunds: {
              select: {
                id: true,
                productId: true,
                examResultId: true,
                patientRefundAmount: true,
                insuranceAdjustmentAmount: true,
                totalAdjustmentAmount: true,
                reason: true,
                approvalId: true,
                approval: { select: { status: true } },
              },
            },
            visit: {
              select: {
                id: true,
                createdAt: true,
                endTime: true,
                examResults: {
                  select: {
                    id: true,
                    productId: true,
                    status: true,
                    notPerformedReason: true,
                  },
                },
                patient: {
                  select: {
                    firstName: true,
                    lastName: true,
                    phoneNumber: true,
                    dateOfBirth: true,
                    gender: true,
                    isChild: true,
                  },
                },
                patientInsurance: {
                  select: {
                    insuranceNumber: true,
                    coveragePercentage: true,
                    relationshipType: true,
                    insuranceCompany: {
                      select: {
                        companyName: true,
                      },
                    },
                    employer: {
                      select: {
                        employerName: true,
                      },
                    },
                  },
                },
              },
            },
            discounts: {
              select: {
                id: true,
                amount: true,
                reason: true,
                approval: {
                  select: {
                    status: true,
                  },
                },
              },
            },
            partialPayments: {
              select: {
                id: true,
                amount: true,
                paymentMethod: true,
                createdAt: true,
                processedBy: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
              orderBy: {
                createdAt: "desc",
              },
            },
            processedBy: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        });
        const totalCount = await db.payment.count({
          where: {
            ...where,
          } as Prisma.PaymentWhereInput,
        });
        const pageCount = queryOptions.take
          ? Math.ceil(totalCount / queryOptions.take)
          : 0;
        return {
          data: payments,
          totalCount,
          pageCount,
        };
      },
      DEFAULT_CACHE_TTL.MEDIUM
    );
    return c.json({ data: paymentsData }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const markPaymentAsPaid = async (c: Context) => {
  try {
    const user = c.get("user");
    const paymentId = c.req.param("paymentId");
    const numericPaymentId = Number.parseInt(paymentId, 10);
    const data = c.get("validatedJson");

    const payment = await findPaymentById(paymentId);

    if (!payment) {
      return c.json(
        { error: "Payment not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (payment.paymentStatus === PaymentStatus.PAID) {
      return c.json(
        { error: "Payment already paid" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const { totalDueAmount, currentPaidAmount, remainingAmount } =
      calculatePaymentTotals(payment);
    const paymentAmount = data.amount;

    if (payment.paymentStatus === PaymentStatus.CANCELLED) {
      return c.json(
        { error: "Payment is already processed or cancelled" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const validationError = validatePaymentAmountInput({
      paymentAmount,
      remainingAmount,
      allowPartial: payment.allowPartial,
    });

    if (validationError) {
      return c.json(
        { error: validationError },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const newPaidAmount = currentPaidAmount + paymentAmount;
    const isFullyPaid = newPaidAmount >= totalDueAmount;

    const updatedPayment = await recordPaymentTransaction({
      paymentId: numericPaymentId,
      paymentAmount,
      paymentMethod: data.paymentMethod,
      userId: Number(user.id),
      newPaidAmount,
      isFullyPaid,
      isSingleUpfrontPayment:
        payment.allowPartial === false && paymentAmount === remainingAmount,
    });

    await handlePostPaymentEffects({
      originalPayment: payment,
      updatedPayment,
      userId: Number(user.id),
      paymentAmount,
      totalDueAmount,
      newPaidAmount,
    });

    const successMessage = buildPaymentSuccessMessage({
      isFullyPaid,
      paymentAmount,
      newPaidAmount,
      totalDueAmount,
    });

    return c.json(
      { success: true, message: successMessage },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Refund approval has many validation steps
export const requestExamRefundApproval = async (c: Context) => {
  try {
    const user = c.get("user");
    const paymentId = Number.parseInt(c.req.param("paymentId"), 10);
    const data = c.get("validatedJson");
    const { examResultId, reason } = data;

    const payment = await db.payment.findUnique({
      where: { id: paymentId, clinicId: user.clinic.id },
      select: {
        id: true,
        clinicId: true,
        visitId: true,
        paymentMode: true,
        paymentType: true,
        paymentStatus: true,
        amount: true,
        patientAmount: true,
        insuranceAmount: true,
        paidAmount: true,
        insuranceClaimId: true,
        paymentDetails: true,
        refunds: {
          select: {
            id: true,
            productId: true,
            examResultId: true,
            patientRefundAmount: true,
            insuranceAdjustmentAmount: true,
            totalAdjustmentAmount: true,
            reason: true,
            approvalId: true,
            approval: { select: { status: true } },
          },
        },
        visit: {
          select: {
            id: true,
            patient: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });

    if (!payment) {
      return c.json(
        { error: "Payment not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (payment.paymentType !== PaymentType.ADDITIONAL_EXAM) {
      return c.json(
        { error: "Refunds can only be requested for exam bills" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    if (
      payment.paymentStatus === PaymentStatus.CANCELLED ||
      payment.paymentStatus === ("DELETED" as PaymentStatus)
    ) {
      return c.json(
        { error: "Refunds cannot be requested for cancelled bills" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const examResult = await db.examResult.findUnique({
      where: { id: examResultId },
      select: {
        id: true,
        examId: true,
        visitId: true,
        productId: true,
        status: true,
        notPerformedReason: true,
        results: true,
      },
    });

    const paymentDetails =
      (payment.paymentDetails as unknown as PaymentDetailLike[]) || [];
    const matchingLine = paymentDetails.find(
      (line) => line.productId === examResult?.productId
    );

    if (
      !examResult ||
      examResult.visitId !== payment.visitId ||
      !matchingLine
    ) {
      return c.json(
        { error: "Exam result not found for this bill" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (examResult.status !== "NOT_PERFORMED") {
      return c.json(
        {
          error: "Only unperformed exams can be submitted for refund approval",
        },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const existingRefund = await db.refund.findFirst({
      where: {
        paymentId,
        examResultId,
        ...(examResult.productId != null && {
          productId: examResult.productId,
        }),
      },
      select: { id: true },
    });

    if (existingRefund) {
      return c.json(
        { error: "This exam line has already been refunded" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const pendingRefundApprovals = await db.approval.findMany({
      where: {
        clinicId: user.clinic.id,
        type: "REFUND",
        status: "PENDING",
        examId: examResult.examId,
      },
      select: { id: true, payload: true },
    });

    const duplicatePendingApproval = pendingRefundApprovals.find((a) => {
      const pl = a.payload as {
        paymentId?: number;
        examResultId?: number;
        productId?: number;
      } | null;
      return (
        pl &&
        Number(pl.paymentId) === paymentId &&
        Number(pl.examResultId) === examResultId &&
        pl.productId === examResult.productId
      );
    });

    if (duplicatePendingApproval) {
      return c.json(
        {
          error: "A refund approval is already pending for this exam line",
        },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const insuranceClaim = payment.insuranceClaimId
      ? await db.insuranceClaim.findUnique({
          where: { id: payment.insuranceClaimId },
          select: { claimStatus: true },
        })
      : null;

    const patientName = [
      payment.visit?.patient.firstName,
      payment.visit?.patient.lastName,
    ]
      .filter(Boolean)
      .join(" ");

    const payload = buildRefundApprovalPayload({
      payment: {
        ...payment,
        amount: Number(payment.amount),
        patientAmount: Number(payment.patientAmount),
        insuranceAmount: Number(payment.insuranceAmount),
        paidAmount: Number(payment.paidAmount),
        paymentDetails: payment.paymentDetails as Parameters<
          typeof buildRefundApprovalPayload
        >[0]["payment"]["paymentDetails"],
        refunds: payment.refunds.map((r) => ({
          ...r,
          patientRefundAmount: Number(r.patientRefundAmount),
          insuranceAdjustmentAmount: Number(r.insuranceAdjustmentAmount),
          totalAdjustmentAmount: Number(r.totalAdjustmentAmount),
        })),
      },
      examResult: {
        ...examResult,
        status: examResult.status,
        productId: examResult.productId ?? undefined,
        results:
          typeof examResult.results === "string"
            ? (JSON.parse(examResult.results) as { productName?: string })
            : (examResult.results as { productName?: string }),
      },
      patientName: patientName || "Unknown patient",
      insuranceClaimStatus: insuranceClaim?.claimStatus ?? null,
    });

    const approval = await db.approval.create({
      data: {
        type: "REFUND",
        clinicId: user.clinic.id,
        branchId: user.branchId ?? undefined,
        requestedById: Number(user.id),
        reason: reason ?? examResult.notPerformedReason ?? undefined,
        examId: examResult.examId,
        payload,
      },
    });

    return c.json(
      {
        success: true,
        message: "Refund approval submitted successfully",
        data: approval,
      },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const exportPayments = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId, branchId } = getScope(user, params);
    const queryOptions = buildQueryOptions<Payment>(params, {
      ...(typeof clinicId === "number" ? { clinicId } : {}),
      ...(typeof branchId === "number" ? { branchId } : {}),
    });
    const { where, orderBy, ...restOptions } = queryOptions;
    const payments = await db.payment.findMany({
      where: {
        ...where,
      } as Prisma.PaymentWhereInput,
      orderBy: orderBy as Prisma.PaymentOrderByWithRelationInput,
      ...restOptions,
      select: {
        id: true,
        amount: true,
        insuranceAmount: true,
        patientAmount: true,
        paymentType: true,
        paymentMethod: true,
        paymentMode: true,
        updatedAt: true,
        visit: {
          select: {
            id: true,
            patient: {
              select: {
                firstName: true,
                lastName: true,
                phoneNumber: true,
                gender: true,
                isChild: true,
              },
            },
            patientInsurance: {
              select: {
                insuranceNumber: true,
                coveragePercentage: true,
                relationshipType: true,
                insuranceCompany: {
                  select: {
                    companyName: true,
                  },
                },
                employer: {
                  select: {
                    employerName: true,
                  },
                },
              },
            },
          },
        },
        discounts: {
          select: {
            id: true,
            amount: true,
            reason: true,
          },
        },
      },
    });
    return c.json({ data: payments }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
