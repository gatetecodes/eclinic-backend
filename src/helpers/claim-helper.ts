import { format } from "date-fns";
import { type Payment, PaymentMode, type Visit } from "../../generated/prisma";
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

export async function createAutomaticClaim(
  visit: Visit & {
    payments: (Payment & {
      products: { id: number }[];
    })[];
    patientInsurance: { id: number } | null;
  }
) {
  if (
    visit.paymentMode !== PaymentMode.INSURANCE ||
    !visit.patientInsurance?.id
  ) {
    return null;
  }

  // Group payments by product for claim items
  const claimItems = visit.payments.flatMap((payment) => {
    if (!payment.paymentDetails) {
      return [
        {
          productId: payment.products[0]?.id || 0,
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
    const claim = await db.insuranceClaim.create({
      data: {
        claimNumber: await generateClaimNumber(),
        visit: { connect: { id: visit.id } },
        clinic: { connect: { id: visit.clinicId } },
        branch: { connect: { id: visit.branchId || 0 } },
        patientInsurance: { connect: { id: visit.patientInsurance.id } },
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

    return claim;
  } catch (error) {
    logger.error("Error creating automatic claim", { error });
    return null;
  }
}
