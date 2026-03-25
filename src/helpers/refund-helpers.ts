import {
  ApprovalStatus,
  PaymentMode,
  PaymentStatus,
} from "../../generated/prisma/client";

export type PaymentDetailLike = {
  productId?: number;
  examResultId?: number;
  inventoryItemId?: number;
  batchId?: number;
  batchNumber?: string;
  productName: string;
  amount: number;
  patientAmount: number;
  insuranceAmount: number;
  quantity?: number;
  numbering?: string;
};

export type RefundLike = {
  id?: number;
  productId?: number | null;
  examResultId?: number;
  patientRefundAmount: number;
  insuranceAdjustmentAmount: number;
  totalAdjustmentAmount: number;
  reason?: string | null;
  approvalId?: number | null;
  createdAt?: Date | string;
  approval?: {
    status?: ApprovalStatus;
  } | null;
};

export type DiscountLike = {
  amount: number;
  approval?: {
    status?: ApprovalStatus;
  } | null;
};

export type NetPaymentLineItem = PaymentDetailLike & {
  originalAmount: number;
  originalPatientAmount: number;
  originalInsuranceAmount: number;
  refundedAmount: number;
  refundedPatientAmount: number;
  refundedInsuranceAmount: number;
  netAmount: number;
  netPatientAmount: number;
  netInsuranceAmount: number;
  isRefunded: boolean;
};

export const toCurrencyNumber = (value: unknown): number => Number(value || 0);

export const getApprovedDiscountTotal = (discounts: DiscountLike[] = []) =>
  discounts.reduce((sum, discount) => {
    if (discount.approval?.status === ApprovalStatus.APPROVED) {
      return sum + toCurrencyNumber(discount.amount);
    }
    return sum;
  }, 0);

const isApprovedRefund = (refund: RefundLike) =>
  refund.approval?.status === ApprovalStatus.APPROVED;

export const getRefundTotals = (refunds: RefundLike[] = []) =>
  refunds.filter(isApprovedRefund).reduce(
    (totals, refund) => ({
      patient: totals.patient + toCurrencyNumber(refund.patientRefundAmount),
      insurance:
        totals.insurance + toCurrencyNumber(refund.insuranceAdjustmentAmount),
      total: totals.total + toCurrencyNumber(refund.totalAdjustmentAmount),
    }),
    { patient: 0, insurance: 0, total: 0 }
  );

const getGroupingKey = (item: {
  examResultId?: number | null;
  productId?: number | null;
}): string | null => {
  if (item.examResultId) {
    return `exam:${item.examResultId}`;
  }
  if (item.productId) {
    return `prod:${item.productId}`;
  }
  return null;
};

export const buildNetPaymentLineItems = (
  paymentDetails: PaymentDetailLike[] = [],
  refunds: RefundLike[] = []
): NetPaymentLineItem[] => {
  const refundMap = new Map<string, RefundLike[]>();
  const approvedRefunds = refunds.filter(isApprovedRefund);

  for (const refund of approvedRefunds) {
    const key = getGroupingKey(refund);
    if (!key) {
      continue;
    }
    const current = refundMap.get(key) || [];
    current.push(refund);
    refundMap.set(key, current);
  }

  const sumOriginalByKey = new Map<
    string,
    { amount: number; patientAmount: number; insuranceAmount: number }
  >();
  for (const detail of paymentDetails) {
    const key = getGroupingKey(detail);
    if (!key) {
      continue;
    }
    const current = sumOriginalByKey.get(key) ?? {
      amount: 0,
      patientAmount: 0,
      insuranceAmount: 0,
    };
    current.amount += toCurrencyNumber(detail.amount);
    current.patientAmount += toCurrencyNumber(detail.patientAmount);
    current.insuranceAmount += toCurrencyNumber(detail.insuranceAmount);
    sumOriginalByKey.set(key, current);
  }

  const totalRefundedByKey = new Map<
    string,
    { total: number; patient: number; insurance: number }
  >();
  refundMap.forEach((refundList, key) => {
    const total = refundList.reduce(
      (s, r) => s + toCurrencyNumber(r.totalAdjustmentAmount),
      0
    );
    const patient = refundList.reduce(
      (s, r) => s + toCurrencyNumber(r.patientRefundAmount),
      0
    );
    const insurance = refundList.reduce(
      (s, r) => s + toCurrencyNumber(r.insuranceAdjustmentAmount),
      0
    );
    totalRefundedByKey.set(key, { total, patient, insurance });
  });

  return paymentDetails.map((detail) => {
    const key = getGroupingKey(detail);
    const sums = key ? sumOriginalByKey.get(key) : null;
    const totals = key ? totalRefundedByKey.get(key) : null;

    let refundedAmount = 0;
    let refundedPatientAmount = 0;
    let refundedInsuranceAmount = 0;

    if (sums && totals && sums.amount > 0) {
      const share = toCurrencyNumber(detail.amount) / sums.amount;
      refundedAmount = share * totals.total;
      refundedPatientAmount = share * totals.patient;
      refundedInsuranceAmount = share * totals.insurance;
    }

    const origAmount = toCurrencyNumber(detail.amount);
    const origPatient = toCurrencyNumber(detail.patientAmount);
    const origInsurance = toCurrencyNumber(detail.insuranceAmount);
    refundedAmount = Math.min(refundedAmount, origAmount);
    refundedPatientAmount = Math.min(refundedPatientAmount, origPatient);
    refundedInsuranceAmount = Math.min(refundedInsuranceAmount, origInsurance);

    return {
      ...detail,
      originalAmount: origAmount,
      originalPatientAmount: origPatient,
      originalInsuranceAmount: origInsurance,
      refundedAmount,
      refundedPatientAmount,
      refundedInsuranceAmount,
      netAmount: Math.max(0, origAmount - refundedAmount),
      netPatientAmount: Math.max(0, origPatient - refundedPatientAmount),
      netInsuranceAmount: Math.max(0, origInsurance - refundedInsuranceAmount),
      isRefunded: refundedAmount > 0,
    };
  });
};

export const getPaymentStatusAfterAdjustment = ({
  paymentMode,
  patientAmount,
  paidAmount,
}: {
  paymentMode: PaymentMode;
  patientAmount: number;
  paidAmount: number;
}) => {
  const normalizedPatientAmount = Math.max(0, toCurrencyNumber(patientAmount));
  const normalizedPaidAmount = Math.max(0, toCurrencyNumber(paidAmount));

  if (paymentMode === PaymentMode.INSURANCE) {
    if (normalizedPatientAmount === 0) {
      return PaymentStatus.PAID;
    }
    if (normalizedPaidAmount === 0) {
      return PaymentStatus.PENDING;
    }
    if (normalizedPaidAmount < normalizedPatientAmount) {
      return PaymentStatus.PARTIALLY_PAID;
    }
    return PaymentStatus.PAID;
  }
  if (normalizedPatientAmount === 0) {
    return PaymentStatus.PAID;
  }
  if (normalizedPaidAmount === 0) {
    return PaymentStatus.PENDING;
  }
  if (normalizedPaidAmount < normalizedPatientAmount) {
    return PaymentStatus.PARTIALLY_PAID;
  }
  return PaymentStatus.PAID;
};

export const getRefundableAmountsForLine = ({
  paidAmount,
  patientAmount,
  insuranceAmount,
}: {
  paidAmount: number;
  patientAmount: number;
  insuranceAmount: number;
}) => {
  const refundablePatientAmount = Math.min(
    Math.max(0, toCurrencyNumber(patientAmount)),
    Math.max(0, toCurrencyNumber(paidAmount))
  );
  const refundableInsuranceAmount = Math.max(
    0,
    toCurrencyNumber(insuranceAmount)
  );

  return {
    patientRefundAmount: refundablePatientAmount,
    insuranceAdjustmentAmount: refundableInsuranceAmount,
    totalAdjustmentAmount: refundablePatientAmount + refundableInsuranceAmount,
  };
};
