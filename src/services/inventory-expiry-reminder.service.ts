import { addDays, differenceInCalendarDays, startOfDay } from "date-fns";
import {
  Role,
  TransactionType,
  UserStatus,
} from "../../generated/prisma/client";
import { db } from "../database/db";
import { translate } from "../lib/i18n";
import { DEFAULT_LOCALE, normalizeLocale } from "../lib/locale";
import { logger } from "../lib/logger";
import { sendEmail } from "./email.service";

const EXPIRY_LEAD_DAYS = 30;
const REMINDER_INTERVAL_DAYS = 7;
const EMAIL_TEMPLATE = "inventory-expiry-warning";

type BatchWithRelations = Awaited<
  ReturnType<
    typeof db.inventoryBatch.findMany<{
      include: {
        item: {
          select: {
            id: true;
            itemName: true;
            clinicId: true;
            clinic: { select: { id: true; name: true; defaultLocale: true } };
          };
        };
        expiryNotification: true;
      };
    }>
  >
>[number];

type ClinicNotificationPayload = {
  clinicId: number;
  clinicName: string;
  locale: string;
  batches: Array<{
    batchId: number;
    batchNumber: string;
    itemId: number;
    itemName: string;
    expiryDate: Date;
    currentQuantity: number;
    daysUntilExpiry: number;
  }>;
};

const shouldSendNotification = (
  batch: BatchWithRelations,
  today: Date
): boolean => {
  const expiry = batch.expiryDate;
  if (!expiry) {
    return false;
  }

  const notification = batch.expiryNotification;
  if (notification?.resolvedAt) {
    return false;
  }

  if (!notification?.lastNotificationAt) {
    return true;
  }

  const daysSinceLastNotification = differenceInCalendarDays(
    today,
    startOfDay(notification.lastNotificationAt)
  );
  return daysSinceLastNotification >= REMINDER_INTERVAL_DAYS;
};

const buildClinicPayloads = (
  batches: BatchWithRelations[],
  today: Date
): Map<number, ClinicNotificationPayload> => {
  const payloads = new Map<number, ClinicNotificationPayload>();

  for (const batch of batches) {
    const expiry = batch.expiryDate;
    const clinicId = batch.item.clinicId;

    if (!expiry || clinicId === null) {
      continue;
    }

    const daysUntilExpiry = differenceInCalendarDays(startOfDay(expiry), today);

    const clinicPayload = payloads.get(clinicId) ?? {
      clinicId,
      clinicName: batch.item.clinic?.name ?? "Clinic",
      locale: batch.item.clinic?.defaultLocale ?? DEFAULT_LOCALE,
      batches: [],
    };

    clinicPayload.batches.push({
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      itemId: batch.item.id,
      itemName: batch.item.itemName,
      expiryDate: expiry,
      currentQuantity: batch.currentQuantity,
      daysUntilExpiry,
    });

    payloads.set(clinicId, clinicPayload);
  }

  return payloads;
};

export const sendInventoryExpiryReminders = async (
  referenceDate = new Date()
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
) => {
  const today = startOfDay(referenceDate);
  const thresholdDate = addDays(today, EXPIRY_LEAD_DAYS);

  try {
    const candidateBatches = await db.inventoryBatch.findMany({
      where: {
        expiryDate: {
          not: null,
          lte: thresholdDate,
        },
        currentQuantity: { gt: 0 },
        transactions: {
          none: {
            type: TransactionType.DISPOSAL,
          },
        },
      },
      include: {
        item: {
          select: {
            id: true,
            itemName: true,
            clinicId: true,
            clinic: {
              select: {
                id: true,
                name: true,
                defaultLocale: true,
              },
            },
          },
        },
        expiryNotification: true,
      },
    });

    const batchesToNotify = candidateBatches.filter((batch) =>
      shouldSendNotification(batch, today)
    );

    if (batchesToNotify.length === 0) {
      logger.info("No inventory expiry notifications to send today");
      return { sent: 0 };
    }

    const clinicPayloads = buildClinicPayloads(batchesToNotify, today);
    const clinicIds = Array.from(clinicPayloads.keys());

    const clinicAdmins = await db.user.findMany({
      where: {
        clinicId: { in: clinicIds },
        role: Role.CLINIC_ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: {
        clinicId: true,
        email: true,
        name: true,
      },
    });

    const adminEmailsByClinic = new Map<number, string[]>();
    for (const admin of clinicAdmins) {
      if (admin.clinicId === null) {
        continue;
      }
      const list = adminEmailsByClinic.get(admin.clinicId) ?? [];
      list.push(admin.email);
      adminEmailsByClinic.set(admin.clinicId, list);
    }

    let emailsSent = 0;
    const updates: Array<{
      batchId: number;
      clinicId: number;
      itemId: number;
    }> = [];

    for (const payload of clinicPayloads.values()) {
      const recipients = adminEmailsByClinic.get(payload.clinicId) ?? [];
      if (recipients.length === 0) {
        logger.warn("No clinic admin emails found for clinic", {
          clinicId: payload.clinicId,
        });
        continue;
      }

      try {
        const locale = normalizeLocale(payload.locale) ?? DEFAULT_LOCALE;
        await sendEmail({
          to: recipients,
          subject: translate(locale, "email.inventory.subject"),
          template: EMAIL_TEMPLATE,
          context: {
            logoAlt: translate(locale, "email.inventory.logoAlt"),
            greeting: translate(locale, "email.inventory.greeting"),
            title: translate(locale, "email.inventory.title"),
            clinicLabel: translate(locale, "email.inventory.clinicLabel"),
            intro: translate(locale, "email.inventory.intro"),
            clinicName: payload.clinicName,
            itemLabel: translate(locale, "email.inventory.item"),
            batchLabel: translate(locale, "email.inventory.batch"),
            expiryDateLabel: translate(locale, "email.inventory.expiryDate"),
            daysRemainingLabel: translate(
              locale,
              "email.inventory.daysRemaining"
            ),
            quantityLabel: translate(locale, "email.inventory.quantity"),
            batches: payload.batches.map((batch) => ({
              itemName: batch.itemName,
              batchNumber: batch.batchNumber,
              expiryDate: batch.expiryDate.toISOString().slice(0, 10),
              daysUntilExpiry: batch.daysUntilExpiry,
              quantity: batch.currentQuantity,
            })),
            footerText: translate(locale, "email.inventory.footer"),
            signatureText: translate(locale, "email.inventory.signature"),
            teamText: translate(locale, "email.inventory.team"),
          },
        });

        for (const batch of payload.batches) {
          updates.push({
            batchId: batch.batchId,
            clinicId: payload.clinicId,
            itemId: batch.itemId,
          });
        }

        emailsSent++;
      } catch (error) {
        logger.error("Failed to send inventory expiry email", {
          clinicId: payload.clinicId,
          error,
        });
      }
    }

    if (updates.length > 0) {
      await db.$transaction(async (tx) => {
        for (const update of updates) {
          await tx.inventoryExpiryNotification.upsert({
            where: { batchId: update.batchId },
            update: {
              lastNotificationAt: referenceDate,
              updatedAt: referenceDate,
            },
            create: {
              batchId: update.batchId,
              clinicId: update.clinicId,
              itemId: update.itemId,
              firstNotificationAt: referenceDate,
              lastNotificationAt: referenceDate,
            },
          });
        }
      });
    }

    logger.info("Inventory expiry reminder run completed", {
      candidateBatches: candidateBatches.length,
      notifiedBatches: updates.length,
      emailsSent,
    });

    return { sent: emailsSent };
  } catch (error) {
    logger.error("Inventory expiry reminder run failed", { error });
    throw error;
  }
};
