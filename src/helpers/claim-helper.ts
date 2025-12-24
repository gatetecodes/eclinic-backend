import { format } from "date-fns";
import type { Payment } from "../../generated/prisma/client";
import { db } from "../database/db";
import { logger } from "../lib/logger";

export async function generateClaimNumber(): Promise<string> {
  const date = format(new Date(), "yyyyMMdd");
  const prefix = "ICL";

  const lastClaim = await db.insuranceClaim.findFirst({
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
  payments: (Payment & {
    products: { id: number }[];
  })[];
}) {
  // Group payments by product for claim items
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

  try {
    return await db.$transaction(async (tx) => {
      const claim = await tx.insuranceClaim.create({
        data: {
          claimNumber: await generateClaimNumber(),
          visit: { connect: { id: visitId } },
          clinic: { connect: { id: clinicId } },
          branch: { connect: { id: branchId || 0 } },
          patientInsurance: { connect: { id: patientInsuranceId } },
          totalAmount,
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
