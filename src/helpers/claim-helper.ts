import { format } from "date-fns";
import {
  ClaimSource,
  type Payment,
  PaymentMode,
  PaymentStatus,
  type Prisma,
} from "../../generated/prisma/client";
import { db } from "../database/db";
import { logger } from "../lib/logger";

type PaymentWithProducts = Payment & { products: { id: number }[] };

// Build claim line items from a set of insurance payments. Prefers the
// per-product breakdown stored in paymentDetails, falling back to the
// payment's single linked product when no breakdown is present.
export function buildClaimItems(payments: PaymentWithProducts[]) {
  const claimItems = payments.flatMap((payment) => {
    if (!payment.paymentDetails) {
      if (!payment.products[0]?.id) {
        logger.error("No product found for payment fallback");
        return [];
      }
      return [
        {
          productId: payment.products[0].id,
          quantity: 1,
          amount: Number(payment.amount),
          insuranceAmount: Number(payment.insuranceAmount),
        },
      ];
    }

    const details = payment.paymentDetails as Array<{
      productName: string;
      amount: number;
      patientAmount: number;
      insuranceAmount: number;
      productId: number;
      quantity: number;
    }>;

    return details.map((detail) => ({
      productId: detail.productId,
      quantity: detail.quantity,
      amount: detail.amount,
      insuranceAmount: detail.insuranceAmount,
    }));
  });

  const totalAmount = claimItems.reduce(
    (sum, item) => sum + item.insuranceAmount,
    0
  );

  return { claimItems, totalAmount };
}

export async function generateClaimNumber(
  tx?: Prisma.TransactionClient
): Promise<string> {
  const date = format(new Date(), "yyyyMMdd");
  const prefix = "ICL";

  const client = tx || db;

  const lastClaim = await client.insuranceClaim.findFirst({
    where: {
      claimNumber: {
        startsWith: `${prefix}${date}`,
      },
    },
    orderBy: {
      claimNumber: "desc",
    },
  });

  const sequence = lastClaim
    ? String(Number(lastClaim.claimNumber.slice(-5)) + 1).padStart(5, "0")
    : "00001";

  return `${prefix}${date}${sequence}`;
}

export async function createAutomaticClaim({
  visitId,
  clinicId,
  branchId,
  patientInsuranceId,
  payments,
}: {
  visitId: number;
  clinicId: number;
  branchId: number | null;
  patientInsuranceId: number;
  payments: PaymentWithProducts[];
}) {
  const { claimItems, totalAmount } = buildClaimItems(payments);

  try {
    return await db.$transaction(async (tx) => {
      const claim = await tx.insuranceClaim.create({
        data: {
          claimNumber: await generateClaimNumber(tx),
          visit: { connect: { id: visitId } },
          clinic: { connect: { id: clinicId } },
          ...(branchId ? { branch: { connect: { id: branchId } } } : {}),
          patientInsurance: { connect: { id: patientInsuranceId } },
          totalAmount,
          source: ClaimSource.CRON,
          items: {
            create: claimItems.map((item) => ({
              product: { connect: { id: item.productId } },
              quantity: item.quantity,
              amount: item.amount,
              insuranceAmount: item.insuranceAmount,
              itemStatus: "PENDING",
            })),
          },
        },
        include: {
          items: true,
        },
      });

      // Link payments to the claim
      await tx.payment.updateMany({
        where: {
          id: { in: payments.map((p) => p.id) },
        },
        data: {
          insuranceClaimId: claim.id,
        },
      });

      return claim;
    });
  } catch (error) {
    logger.error("Error creating automatic claim", { error });
    return null;
  }
}

// Synchronously generate the insurance claim for a single visit, within an
// existing transaction (used at discharge time). Idempotent: only picks up
// PAID insurance payments not yet attached to a claim, so it is safe to run
// alongside the nightly cron — whichever runs first claims the payments and
// the other finds nothing to do.
export async function createClaimForVisit(
  tx: Prisma.TransactionClient,
  visitId: number,
  source: ClaimSource
) {
  const visit = await tx.visit.findUnique({
    where: { id: visitId },
    select: {
      id: true,
      clinicId: true,
      branchId: true,
      patientInsuranceId: true,
      paymentMode: true,
    },
  });

  if (
    !visit ||
    visit.paymentMode !== PaymentMode.INSURANCE ||
    !visit.patientInsuranceId
  ) {
    return null;
  }

  const payments = await tx.payment.findMany({
    where: {
      visitId,
      paymentMode: PaymentMode.INSURANCE,
      paymentStatus: PaymentStatus.PAID,
      insuranceClaimId: null,
    },
    include: { products: { select: { id: true } } },
  });

  if (payments.length === 0) {
    return null;
  }

  const { claimItems, totalAmount } = buildClaimItems(payments);
  if (claimItems.length === 0) {
    return null;
  }

  const claim = await tx.insuranceClaim.create({
    data: {
      claimNumber: await generateClaimNumber(tx),
      visit: { connect: { id: visit.id } },
      clinic: { connect: { id: visit.clinicId } },
      ...(visit.branchId
        ? { branch: { connect: { id: visit.branchId } } }
        : {}),
      patientInsurance: { connect: { id: visit.patientInsuranceId } },
      totalAmount,
      source,
      items: {
        create: claimItems.map((item) => ({
          product: { connect: { id: item.productId } },
          quantity: item.quantity,
          amount: item.amount,
          insuranceAmount: item.insuranceAmount,
          itemStatus: "PENDING",
        })),
      },
    },
    include: { items: true },
  });

  await tx.payment.updateMany({
    where: { id: { in: payments.map((p) => p.id) } },
    data: { insuranceClaimId: claim.id },
  });

  return claim;
}
