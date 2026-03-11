import { AppError } from "@/lib/app-error";
import { httpCodes } from "@/lib/constants";
import {
  ActivityType,
  ApprovalStatus,
  type Payment,
  PaymentStatus,
  PaymentType,
  type Prisma,
  VisitStatus,
} from "../../generated/prisma/client";
import { db } from "../database/db";
import {
  invalidatePaymentRelatedCaches,
  invalidateVisitRelatedCaches,
} from "../lib/cache-utils";
import { QueueIntegrationService } from "../services/queue-integration.service";
import { logActivity } from "./activity-helpers";

export const visitSelection = {
  select: {
    id: true,
    status: true,
    isLabOnly: true,
    patientId: true,
    departmentId: true,
    doctorId: true,
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

type SelectedVisit = Prisma.VisitGetPayload<typeof visitSelection>;

export type PaymentWithVisit = Prisma.PaymentGetPayload<{
  select: {
    id: true;
    paymentStatus: true;
    paymentType: true;
    patientAmount: true;
    paidAmount: true;
    allowPartial: true;
    discounts: {
      select: {
        amount: true;
        approval: {
          select: {
            status: true;
          };
        };
      };
    };
    visit: typeof visitSelection;
  };
}>;

export type UpdatedPaymentWithVisit = Prisma.PaymentGetPayload<{
  include: {
    visit: typeof visitSelection;
  };
}>;

export const findPaymentById = async (paymentId: string | number) => {
  const id = typeof paymentId === "string" ? Number(paymentId) : paymentId;

  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError({
      status: httpCodes.BAD_REQUEST,
      code: "INVALID_PAYMENT_ID",
      message: "Invalid payment id",
    });
  }
  return await db.payment.findUnique({
    where: { id },
    select: {
      id: true,
      paymentStatus: true,
      paymentType: true,
      patientAmount: true,
      paidAmount: true,
      allowPartial: true,
      discounts: {
        select: {
          amount: true,
          approval: {
            select: {
              status: true,
            },
          },
        },
      },
      visit: visitSelection,
    },
  });
};

const getNextVisitStatus = (
  payment: PaymentWithVisit
): VisitStatus | undefined => {
  const visitStatus = payment.visit?.status;

  // New flow: When consultation payment is paid and visit is CHECKED_IN, move to IN_PRE_CONSULTATION
  if (
    visitStatus === VisitStatus.CHECKED_IN &&
    payment.paymentType === PaymentType.CONSULTATION
  ) {
    return VisitStatus.IN_PRE_CONSULTATION;
  }

  // Legacy flow: When consultation payment is paid and visit is TRIAGE_COMPLETED, move to IN_CONSULTATION
  if (
    visitStatus === VisitStatus.TRIAGE_COMPLETED &&
    payment.paymentType === PaymentType.CONSULTATION
  ) {
    return VisitStatus.IN_CONSULTATION;
  }

  if (payment.paymentType !== PaymentType.ADDITIONAL_EXAM) {
    return;
  }

  if (
    visitStatus === VisitStatus.IN_CONSULTATION ||
    visitStatus === VisitStatus.RESULTS_READY ||
    (visitStatus === VisitStatus.CHECKED_IN && payment.visit?.isLabOnly)
  ) {
    return VisitStatus.PENDING_TESTS;
  }

  return;
};

const logFullPaymentFlow = async ({
  visit,
  userId,
  paymentType,
  originalPayment,
}: {
  visit: SelectedVisit;
  userId: number;
  paymentType: PaymentType;
  originalPayment: PaymentWithVisit;
}) => {
  const patientName = `${visit.patient.firstName} ${visit.patient.lastName}`;

  await logActivity({
    userId,
    visitId: visit.id,
    action: `${patientName}'s ${paymentType} payment marked as paid`,
    type: ActivityType.PAYMENT,
  });

  const nextVisitStatus = getNextVisitStatus(originalPayment);
  if (!nextVisitStatus) {
    return;
  }

  await db.visit.update({
    where: { id: visit.id },
    data: { status: nextVisitStatus },
  });

  if (
    nextVisitStatus === VisitStatus.IN_PRE_CONSULTATION &&
    visit.departmentId &&
    visit.branchId
  ) {
    QueueIntegrationService.ensurePatientInNursePreConsultationQueue({
      departmentId: visit.departmentId,
      patientId: visit.patientId,
      clinicId: visit.clinicId,
      branchId: visit.branchId,
      visitId: visit.id,
    }).catch(() => {
      /* Queue integration is best-effort; do not fail payment flow */
    });
  } else if (nextVisitStatus === VisitStatus.PENDING_TESTS && visit.branchId) {
    QueueIntegrationService.ensurePatientInLabQueue({
      patientId: visit.patientId,
      clinicId: visit.clinicId,
      branchId: visit.branchId,
      visitId: visit.id,
      departmentId: visit.departmentId,
    }).catch(() => {
      /* Queue integration is best-effort; do not fail payment flow */
    });
  }

  if (nextVisitStatus === VisitStatus.IN_CONSULTATION) {
    await logActivity({
      userId,
      visitId: visit.id,
      action: `${patientName} sent to doctor ${visit.doctor?.name} for consultation`,
      type: ActivityType.STATUS_UPDATE,
    });
    return;
  }

  if (nextVisitStatus === VisitStatus.PENDING_TESTS) {
    await logActivity({
      userId,
      visitId: visit.id,
      action: `${patientName} sent for lab tests`,
      type: ActivityType.STATUS_UPDATE,
    });
  }
};

const logPartialPaymentActivity = async ({
  visit,
  userId,
  paymentType,
  paymentAmount,
  newPaidAmount,
  totalDueAmount,
}: {
  visit: SelectedVisit;
  userId: number;
  paymentType: PaymentType;
  paymentAmount: number;
  newPaidAmount: number;
  totalDueAmount: number;
}) =>
  logActivity({
    userId,
    visitId: visit.id,
    action: `${visit.patient.firstName} ${visit.patient.lastName}'s ${paymentType} payment - ${formatCurrency(
      paymentAmount
    )} RWF recorded (${formatCurrency(newPaidAmount)}/${formatCurrency(
      totalDueAmount
    )} RWF paid)`,
    type: ActivityType.PAYMENT,
  });

export const handlePostPaymentEffects = async ({
  originalPayment,
  updatedPayment,
  userId,
  paymentAmount,
  totalDueAmount,
  newPaidAmount,
}: {
  originalPayment: PaymentWithVisit;
  updatedPayment: UpdatedPaymentWithVisit;
  userId: number;
  paymentAmount?: number;
  totalDueAmount?: number;
  newPaidAmount?: number;
}) => {
  const visit = updatedPayment.visit ?? originalPayment.visit;
  const isFullyPaid = updatedPayment.paymentStatus === PaymentStatus.PAID;

  if (visit && isFullyPaid) {
    await logFullPaymentFlow({
      visit,
      userId,
      paymentType: updatedPayment.paymentType,
      originalPayment,
    });
  } else if (
    visit &&
    typeof paymentAmount === "number" &&
    typeof totalDueAmount === "number" &&
    typeof newPaidAmount === "number"
  ) {
    await logPartialPaymentActivity({
      visit,
      userId,
      paymentType: originalPayment.paymentType,
      paymentAmount,
      newPaidAmount,
      totalDueAmount,
    });
  }

  if (!visit) {
    return;
  }

  const { clinicId, branchId, id: visitId } = visit;

  await Promise.all([
    invalidatePaymentRelatedCaches({
      clinicId,
      branchId: branchId ?? undefined,
      visitId,
    }),
    invalidateVisitRelatedCaches({
      clinicId,
      branchId: branchId ?? undefined,
      visitId,
    }),
  ]);
};

const formatCurrency = (value: number) => Number(value).toLocaleString();

export const calculatePaymentTotals = (payment: PaymentWithVisit) => {
  const approvedDiscountAmount = payment.discounts.reduce((total, discount) => {
    if (discount.approval?.status === ApprovalStatus.APPROVED) {
      return total + Number(discount.amount);
    }
    return total;
  }, 0);

  const totalDueAmount = Math.max(
    0,
    Number(payment.patientAmount) - approvedDiscountAmount
  );
  const currentPaidAmount = Number(payment.paidAmount);
  const remainingAmount = Math.max(totalDueAmount - currentPaidAmount, 0);

  return {
    approvedDiscountAmount,
    totalDueAmount,
    currentPaidAmount,
    remainingAmount,
  };
};

export const validatePaymentAmountInput = ({
  paymentAmount,
  remainingAmount,
  allowPartial,
}: {
  paymentAmount: number;
  remainingAmount: number;
  allowPartial: boolean;
}) => {
  if (!Number.isFinite(paymentAmount)) {
    return "Payment amount must be a valid number";
  }
  if (remainingAmount <= 0) {
    //Guard against recording payments when there is no outstanding balance
    if (paymentAmount !== 0) {
      return "There is no outstanding balance to pay";
    }
    return;
  }
  if (paymentAmount <= 0 && remainingAmount > 0) {
    return "Payment amount must be greater than 0";
  }
  if (allowPartial) {
    if (paymentAmount > remainingAmount) {
      return "Payment amount cannot exceed remaining balance";
    }
    return;
  }
  if (paymentAmount !== remainingAmount) {
    return `Payment amount must be exactly ${formatCurrency(
      remainingAmount
    )} RWF (full remaining balance)`;
  }
  return;
};

export const recordPaymentTransaction = async ({
  paymentId,
  paymentAmount,
  paymentMethod,
  userId,
  newPaidAmount,
  isFullyPaid,
  isSingleUpfrontPayment,
}: {
  paymentId: number;
  paymentAmount: number;
  paymentMethod: Payment["paymentMethod"];
  userId: number;
  newPaidAmount: number;
  isFullyPaid: boolean;
  isSingleUpfrontPayment: boolean;
}): Promise<UpdatedPaymentWithVisit> => {
  const { updatedPayment } = await db.$transaction(async (tx) => {
    // For full upfront payments (no partials allowed and paying remaining in one go),
    // skip creating a PartialPayment record and only update the Payment.
    if (!isSingleUpfrontPayment) {
      await tx.partialPayment.create({
        data: {
          paymentId,
          amount: paymentAmount,
          paymentMethod,
          processedById: userId,
        },
      });
    }

    const paymentRecord = await tx.payment.update({
      where: { id: paymentId },
      data: {
        paidAmount: newPaidAmount,
        paymentStatus: isFullyPaid
          ? PaymentStatus.PAID
          : PaymentStatus.PARTIALLY_PAID,
        paymentMethod,
        processedBy: {
          connect: {
            id: userId,
          },
        },
      },
      include: {
        visit: visitSelection,
      },
    });

    return { updatedPayment: paymentRecord };
  });

  return updatedPayment;
};

export const buildPaymentSuccessMessage = ({
  isFullyPaid,
  paymentAmount,
  newPaidAmount,
  totalDueAmount,
}: {
  isFullyPaid: boolean;
  paymentAmount: number;
  newPaidAmount: number;
  totalDueAmount: number;
}) =>
  isFullyPaid
    ? "Payment marked as fully paid"
    : `Partial payment of ${formatCurrency(
        paymentAmount
      )} RWF recorded (${formatCurrency(newPaidAmount)}/${formatCurrency(
        totalDueAmount
      )} RWF paid)`;
