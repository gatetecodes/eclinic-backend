import cron, { type ScheduledTask } from "node-cron";
import { PaymentMode, PaymentStatus } from "../../generated/prisma/client";
import { db } from "../database/db";
import { createAutomaticClaim } from "../helpers/claim-helper";
import { logger } from "../lib/logger";

const DEFAULT_CRON = "0 22 * * *"; // 10pm daily
const DEFAULT_TIMEZONE = "UTC"; //

let insuranceClaimsTask: ScheduledTask | undefined;

export const processInsuranceClaims = async () => {
  logger.info("Starting daily insurance claim generation...");

  try {
    const payments = await db.payment.findMany({
      where: {
        paymentMode: PaymentMode.INSURANCE,
        paymentStatus: PaymentStatus.PAID,
        insuranceClaimId: null,
        visitId: { not: null },
      },
      include: {
        products: { select: { id: true } },
        visit: {
          select: {
            id: true,
            clinicId: true,
            branchId: true,
            patientInsuranceId: true,
          },
        },
      },
    });

    if (payments.length === 0) {
      logger.info("No unclaimed insurance payments found.");
      return;
    }

    const groupedByVisit = payments.reduce(
      (acc, payment) => {
        const { visit } = payment;
        if (!visit) {
          return acc;
        }

        if (!acc[visit.id]) {
          acc[visit.id] = {
            visitId: visit.id,
            clinicId: visit.clinicId,
            branchId: visit.branchId,
            patientInsuranceId: visit.patientInsuranceId,
            payments: [],
          };
        }
        acc[visit.id].payments.push(payment);
        return acc;
      },
      {} as Record<
        number,
        {
          visitId: number;
          clinicId: number;
          branchId: number | null;
          patientInsuranceId: number | null;
          payments: typeof payments;
        }
      >
    );

    for (const group of Object.values(groupedByVisit)) {
      if (!group.patientInsuranceId) {
        logger.error(
          `Visit ${group.visitId} has no patient insurance attached. Skipping claim generation.`
        );
        continue;
      }

      const claim = await createAutomaticClaim({
        visitId: group.visitId,
        clinicId: group.clinicId,
        branchId: group.branchId,
        patientInsuranceId: group.patientInsuranceId,
        payments: group.payments,
      });

      if (claim) {
        logger.info(
          `Generated insurance claim ${claim.claimNumber} for visit ${group.visitId} with ${group.payments.length} payments.`
        );
      } else {
        logger.error(
          `Failed to generate insurance claim for visit ${group.visitId}.`
        );
      }
    }

    logger.info("Insurance claim generation completed.");
  } catch (error) {
    logger.error("Error in processInsuranceClaims job:", { error });
  }
};

export const startInsuranceClaimsCron = () => {
  if (process.env.DISABLE_INSURANCE_CLAIMS_CRON === "true") {
    logger.info("Insurance claims cron job disabled via env flag");
    return;
  }

  if (insuranceClaimsTask) {
    return;
  }

  const schedule = process.env.INSURANCE_CLAIMS_CRON ?? DEFAULT_CRON;
  const timezone = process.env.INSURANCE_CLAIMS_CRON_TZ ?? DEFAULT_TIMEZONE;

  insuranceClaimsTask = cron.schedule(
    schedule,
    async () => {
      await processInsuranceClaims();
    },
    {
      timezone,
    }
  );

  insuranceClaimsTask.start();
  logger.info("Insurance claims cron scheduled", {
    schedule,
    timezone,
  });
};
