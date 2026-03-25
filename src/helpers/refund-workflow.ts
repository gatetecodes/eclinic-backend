import type { Prisma } from "../../generated/prisma/client";
import { ClaimStatus, PaymentType } from "../../generated/prisma/client";
import {
  buildNetPaymentLineItems,
  getPaymentStatusAfterAdjustment,
  getRefundableAmountsForLine,
  type PaymentDetailLike,
  type RefundLike,
  toCurrencyNumber,
} from "./refund-helpers";

export type RefundApprovalPayload = {
  paymentId: number;
  visitId: number;
  examId: number;
  examResultId: number;
  productId?: number;
  requestedAtStatus: string;
  billNumber?: string | null;
  paymentMode: string;
  paymentType: string;
  patient: { fullName: string };
  exam: { productName: string; notPerformedReason?: string | null };
  original: {
    line: {
      productId?: number;
      productName: string;
      quantity: number;
      numbering?: string;
      amount: number;
      patientAmount: number;
      insuranceAmount: number;
    };
    payment: {
      amount: number;
      patientAmount: number;
      insuranceAmount: number;
      paidAmount: number;
      insuranceClaimId?: number | null;
      insuranceClaimStatus?: ClaimStatus | null;
    };
  };
  requested: {
    refund: {
      patientRefundAmount: number;
      insuranceAdjustmentAmount: number;
      totalAdjustmentAmount: number;
    };
  };
};

type PaymentForRefundPayload = {
  id: number;
  visitId: number | null;
  paymentMode: string;
  paymentType: string;
  paymentStatus: string;
  amount: unknown;
  patientAmount: unknown;
  insuranceAmount: unknown;
  paidAmount: unknown;
  insuranceClaimId?: number | null;
  paymentDetails?: PaymentDetailLike[];
  refunds?: RefundLike[];
};

type ExamResultForRefundPayload = {
  id: number;
  examId: number;
  productId?: number | null;
  status: string;
  notPerformedReason?: string | null;
  results?: { productName?: string } | null;
};

export const buildRefundApprovalPayload = ({
  payment,
  examResult,
  patientName,
  insuranceClaimStatus,
}: {
  payment: PaymentForRefundPayload;
  examResult: ExamResultForRefundPayload;
  patientName: string;
  insuranceClaimStatus?: ClaimStatus | null;
}): RefundApprovalPayload => {
  const lineItems = buildNetPaymentLineItems(
    payment.paymentDetails,
    payment.refunds
  );
  const targetLine = lineItems.find(
    (line) => line.productId === examResult.productId
  );

  if (!targetLine) {
    throw new Error("Payment line for this exam could not be found");
  }

  return {
    paymentId: payment.id,
    visitId: Number(payment.visitId),
    examId: examResult.examId,
    examResultId: examResult.id,
    productId: examResult.productId ?? undefined,
    requestedAtStatus: payment.paymentStatus,
    billNumber: undefined,
    paymentMode: payment.paymentMode,
    paymentType: payment.paymentType,
    patient: { fullName: patientName },
    exam: {
      productName:
        targetLine.productName ||
        (examResult.results?.productName as string) ||
        "Exam item",
      notPerformedReason: examResult.notPerformedReason,
    },
    original: {
      line: {
        productId: examResult.productId ?? undefined,
        productName:
          targetLine.productName ||
          (examResult.results?.productName as string) ||
          "Exam item",
        quantity: targetLine.quantity || 1,
        numbering: targetLine.numbering,
        amount: targetLine.netAmount,
        patientAmount: targetLine.netPatientAmount,
        insuranceAmount: targetLine.netInsuranceAmount,
      },
      payment: {
        amount: toCurrencyNumber(payment.amount),
        patientAmount: toCurrencyNumber(payment.patientAmount),
        insuranceAmount: toCurrencyNumber(payment.insuranceAmount),
        paidAmount: toCurrencyNumber(payment.paidAmount),
        insuranceClaimId: payment.insuranceClaimId,
        insuranceClaimStatus,
      },
    },
    requested: {
      refund: getRefundableAmountsForLine({
        paidAmount: toCurrencyNumber(payment.paidAmount),
        patientAmount: targetLine.netPatientAmount,
        insuranceAmount: targetLine.netInsuranceAmount,
      }),
    },
  };
};

const paymentSelectForRefund = {
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
} as const;

type PaymentForApplyRefund = Prisma.PaymentGetPayload<{
  select: typeof paymentSelectForRefund;
}>;

async function loadPaymentForApprovedRefund(
  tx: Prisma.TransactionClient,
  paymentId: number,
  clinicId: number
): Promise<PaymentForApplyRefund> {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: paymentSelectForRefund,
  });

  if (!payment || payment.clinicId !== clinicId) {
    throw new Error("Payment not found");
  }
  if (payment.paymentType !== PaymentType.ADDITIONAL_EXAM) {
    throw new Error("Only additional exam bills can be refunded");
  }
  if (!payment.visitId) {
    throw new Error("Refunded exam bill is missing a visit reference");
  }
  return payment;
}

type ExamResultForApplyRefund = {
  id: number;
  examId: number;
  visitId: number;
  productId: number | null;
  status: string;
  notPerformedReason: string | null;
  results: unknown;
};

async function loadExamResultForApprovedRefund(
  tx: Prisma.TransactionClient,
  examResultId: number
): Promise<ExamResultForApplyRefund> {
  const examResult = await tx.examResult.findUnique({
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

  if (!examResult) {
    throw new Error("Exam result not found");
  }
  if (examResult.status !== "NOT_PERFORMED") {
    throw new Error("Refunds can only be approved for unperformed exams");
  }
  return examResult;
}

async function assertNoDuplicateRefund(
  tx: Prisma.TransactionClient,
  paymentId: number,
  examResult: ExamResultForApplyRefund
): Promise<void> {
  const existingRefund = await tx.refund.findFirst({
    where: {
      paymentId,
      examResultId: examResult.id,
      productId: examResult.productId ?? undefined,
    },
    select: { id: true },
  });

  if (existingRefund) {
    throw new Error("This exam line has already been refunded");
  }
}

async function adjustInsuranceClaimAfterRefund(args: {
  tx: Prisma.TransactionClient;
  payment: PaymentForApplyRefund;
  examResult: ExamResultForApplyRefund;
  targetLine: { netAmount: number; netInsuranceAmount: number };
  insuranceAdjustmentAmount: number;
}): Promise<void> {
  const { tx, payment, examResult, targetLine, insuranceAdjustmentAmount } =
    args;

  if (!payment.insuranceClaimId) {
    return;
  }

  const insuranceClaim = await tx.insuranceClaim.findUnique({
    where: { id: payment.insuranceClaimId },
    select: {
      id: true,
      claimStatus: true,
      totalAmount: true,
      items: {
        select: {
          id: true,
          productId: true,
          amount: true,
          insuranceAmount: true,
        },
      },
    },
  });

  if (insuranceClaim?.claimStatus === ClaimStatus.PAID) {
    throw new Error(
      "Insurance claim is already paid. Refund requires manual follow-up."
    );
  }

  if (
    !insuranceClaim ||
    insuranceAdjustmentAmount <= 0 ||
    !examResult.productId
  ) {
    return;
  }

  const claimItem = insuranceClaim.items.find(
    (item) => item.productId === examResult.productId
  );

  if (!claimItem) {
    return;
  }

  await tx.insuranceClaimItem.update({
    where: { id: claimItem.id },
    data: {
      amount: Math.max(0, Number(claimItem.amount) - targetLine.netAmount),
      insuranceAmount: Math.max(
        0,
        Number(claimItem.insuranceAmount) - insuranceAdjustmentAmount
      ),
    },
  });

  await tx.insuranceClaim.update({
    where: { id: insuranceClaim.id },
    data: {
      totalAmount: Math.max(
        0,
        Number(insuranceClaim.totalAmount) - insuranceAdjustmentAmount
      ),
    },
  });
}

export const applyApprovedRefund = async ({
  tx,
  approvalId,
  userId,
  payload,
  reason,
  clinicId,
}: {
  tx: Prisma.TransactionClient;
  approvalId: number;
  userId: number;
  payload: RefundApprovalPayload;
  reason?: string | null;
  clinicId: number;
}) => {
  const payment = await loadPaymentForApprovedRefund(
    tx,
    payload.paymentId,
    clinicId
  );
  const examResult = await loadExamResultForApprovedRefund(
    tx,
    payload.examResultId
  );

  await assertNoDuplicateRefund(tx, payment.id, examResult);

  const lineItems = buildNetPaymentLineItems(
    payment.paymentDetails as PaymentDetailLike[],
    payment.refunds as unknown as RefundLike[]
  );
  const targetLine = lineItems.find(
    (line) => line.productId === examResult.productId
  );

  if (!targetLine) {
    throw new Error("Refund line could not be found on this bill");
  }

  const {
    patientRefundAmount,
    insuranceAdjustmentAmount,
    totalAdjustmentAmount,
  } = getRefundableAmountsForLine({
    paidAmount: toCurrencyNumber(payment.paidAmount),
    patientAmount: targetLine.netPatientAmount,
    insuranceAmount: targetLine.netInsuranceAmount,
  });

  if (totalAdjustmentAmount <= 0) {
    throw new Error(
      "There is no remaining amount to refund for this exam line"
    );
  }

  await adjustInsuranceClaimAfterRefund({
    tx,
    payment,
    examResult,
    targetLine,
    insuranceAdjustmentAmount,
  });

  const nextAmount = Number(
    Math.max(0, Number(payment.amount) - targetLine.netAmount).toFixed(2)
  );
  const nextPatientAmount = Number(
    Math.max(
      0,
      Number(payment.patientAmount) - targetLine.netPatientAmount
    ).toFixed(2)
  );
  const nextInsuranceAmount = Number(
    Math.max(
      0,
      Number(payment.insuranceAmount) - targetLine.netInsuranceAmount
    ).toFixed(2)
  );
  const nextPaidAmount = Number(
    Math.max(0, Number(payment.paidAmount) - patientRefundAmount).toFixed(2)
  );
  const nextStatus = getPaymentStatusAfterAdjustment({
    paymentMode: payment.paymentMode as "PRIVATE" | "INSURANCE",
    patientAmount: nextPatientAmount,
    paidAmount: nextPaidAmount,
  });

  if (!examResult.productId) {
    throw new Error("Exam result is missing product reference");
  }

  const refund = await tx.refund.create({
    data: {
      clinic: { connect: { id: clinicId } },
      payment: { connect: { id: payment.id } },
      visit: { connect: { id: payment.visitId as number } },
      examResult: { connect: { id: examResult.id } },
      product: { connect: { id: examResult.productId } },
      approval: { connect: { id: approvalId } },
      refundedBy: { connect: { id: userId } },
      patientRefundAmount,
      insuranceAdjustmentAmount,
      totalAdjustmentAmount,
      reason: reason ?? examResult.notPerformedReason,
    },
  });

  await tx.payment.update({
    where: { id: payment.id },
    data: {
      amount: nextAmount,
      patientAmount: nextPatientAmount,
      insuranceAmount: nextInsuranceAmount,
      paidAmount: nextPaidAmount,
      paymentStatus: nextStatus,
    },
  });

  return {
    refund,
    patientRefundAmount,
    insuranceAdjustmentAmount,
    totalAdjustmentAmount,
  };
};
