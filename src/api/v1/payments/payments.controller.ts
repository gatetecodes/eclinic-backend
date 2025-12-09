import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  type Payment,
  PaymentStatus,
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
            visit: {
              select: {
                id: true,
                patient: {
                  select: {
                    firstName: true,
                    lastName: true,
                    phoneNumber: true,
                    dateOfBirth: true,
                  },
                },
                patientInsurance: {
                  select: {
                    insuranceCompany: {
                      select: {
                        companyName: true,
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
              },
            },
            patientInsurance: {
              select: {
                insuranceCompany: {
                  select: {
                    companyName: true,
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
