import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  ActivityType,
  type Payment,
  PaymentStatus,
  PaymentType,
  type Prisma,
  VisitStatus,
} from "../../../../generated/prisma";
import { db } from "../../../database/db";
import { logActivity } from "../../../helpers/activity-helpers";
import { buildQueryOptions } from "../../../helpers/query-helper";
import {
  invalidatePaymentRelatedCaches,
  invalidateVisitRelatedCaches,
} from "../../../lib/cache-utils";
import { searchParamsSchema } from "../../../lib/common-validation";
import { httpCodes } from "../../../lib/constants";
import {
  DEFAULT_CACHE_TTL,
  getCachedData,
} from "../../../services/redis.service";

const visitSelection = {
  select: {
    id: true,
    status: true,
    patient: {
      select: {
        firstName: true,
        lastName: true,
        phoneNumber: true,
        dateOfBirth: true,
      },
    },
    doctor: {
      select: {
        name: true,
      },
    },
    clinicId: true,
    branchId: true,
  },
} as const;

type PaymentWithVisit = Prisma.PaymentGetPayload<{
  select: {
    id: true;
    paymentStatus: true;
    paymentType: true;
    visit: typeof visitSelection;
  };
}>;

type UpdatedPaymentWithVisit = Prisma.PaymentGetPayload<{
  include: {
    visit: typeof visitSelection;
  };
}>;

const findPaymentById = async (paymentId: string) =>
  db.payment.findUnique({
    where: { id: Number(paymentId) },
    select: {
      id: true,
      paymentStatus: true,
      paymentType: true,
      patientAmount: true,
      visit: visitSelection,
    },
  });

const getNextVisitStatus = (
  payment: PaymentWithVisit
): VisitStatus | undefined => {
  if (
    payment.visit?.status === VisitStatus.TRIAGE_COMPLETED &&
    payment.paymentType === PaymentType.CONSULTATION
  ) {
    return VisitStatus.IN_CONSULTATION;
  }
  if (
    payment.visit?.status === VisitStatus.IN_CONSULTATION &&
    payment.paymentType === PaymentType.ADDITIONAL_EXAM
  ) {
    return VisitStatus.PENDING_TESTS;
  }
  return;
};

const handlePostPaymentEffects = async ({
  originalPayment,
  updatedPayment,
  userId,
}: {
  originalPayment: PaymentWithVisit;
  updatedPayment: UpdatedPaymentWithVisit;
  userId: number;
}) => {
  const visit = updatedPayment.visit;

  if (updatedPayment.paymentStatus === PaymentStatus.PAID && visit) {
    await logActivity({
      userId,
      visitId: visit.id,
      action: `${visit.patient.firstName} ${visit.patient.lastName}'s ${updatedPayment.paymentType} payment marked as paid`,
      type: ActivityType.PAYMENT,
    });

    const nextVisitStatus = getNextVisitStatus(originalPayment);

    if (nextVisitStatus) {
      await db.visit.update({
        where: { id: visit.id },
        data: { status: nextVisitStatus },
      });

      if (nextVisitStatus === VisitStatus.IN_CONSULTATION) {
        await logActivity({
          userId,
          visitId: visit.id,
          action: `${visit.patient.firstName} ${visit.patient.lastName} sent to doctor ${visit.doctor?.name} for consultation`,
          type: ActivityType.STATUS_UPDATE,
        });
      }

      if (nextVisitStatus === VisitStatus.PENDING_TESTS) {
        await logActivity({
          userId,
          visitId: visit.id,
          action: `${visit.patient.firstName} ${visit.patient.lastName} sent to lab for additional tests`,
          type: ActivityType.STATUS_UPDATE,
        });
      }
    }
  }

  const clinicId = visit?.clinicId ?? 0;
  const branchId = visit?.branchId ?? 0;
  const visitId = visit?.id ?? 0;

  await invalidatePaymentRelatedCaches({
    clinicId,
    branchId,
    visitId,
  });
  await invalidateVisitRelatedCaches({
    clinicId,
    branchId,
    visitId,
  });
};

export const getPayments = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const queryOptions = buildQueryOptions<Payment>(params);
    const { where, orderBy, ...restOptions } = queryOptions;
    const cacheKey = `payments:${user.clinicId ?? user.clinic.id}:${user.branchId ?? user.branch.id}:${JSON.stringify(params || {})}`;

    const paymentsData = await getCachedData(
      cacheKey,
      async () => {
        const payments = await db.payment.findMany({
          where: {
            ...where,
            clinicId: user.clinicId ?? user.clinic.id,
            branchId: user.branchId ?? user.branch.id,
          } as Prisma.PaymentWhereInput,
          orderBy: orderBy as Prisma.PaymentOrderByWithRelationInput,
          ...restOptions,
          select: {
            id: true,
            amount: true,
            insuranceAmount: true,
            patientAmount: true,
            paymentType: true,
            paymentStatus: true,
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
            clinicId: user.clinicId ?? user.clinic.id,
            branchId: user.branchId ?? user.branch.id,
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

    const update = await db.payment.update({
      where: { id: Number(paymentId) },
      data: {
        paymentStatus: PaymentStatus.PAID,
        paymentMethod: data.paymentMethod,
        paidAmount: payment.patientAmount,
        processedBy: {
          connect: {
            id: Number(user.id),
          },
        },
      },
      include: {
        visit: visitSelection,
      },
    });

    await handlePostPaymentEffects({
      originalPayment: payment,
      updatedPayment: update,
      userId: Number(user.id),
    });
    return c.json({ success: "Payment marked as paid" });
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
    const queryOptions = buildQueryOptions<Payment>(params);
    const { where, orderBy, ...restOptions } = queryOptions;
    const payments = await db.payment.findMany({
      where: {
        ...where,
        clinicId: user.clinic.id,
        branchId: user.branch.id,
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
