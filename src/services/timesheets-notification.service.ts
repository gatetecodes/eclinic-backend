import { addDays, startOfDay } from "date-fns";
import { db } from "../database/db";
import { logger } from "../lib/logger";
import { TIMESHEETS_GOLIVE } from "../lib/timesheets-config";

type TimesheetWithUser = Awaited<
  ReturnType<
    typeof db.staffTimesheet.findMany<{
      include: {
        user: { select: { id: true; name: true; clinicId: true } };
        clinic: { select: { id: true; name: true } };
      };
    }>
  >
>[number];

const buildAdminsByClinicMap = async (
  clinicIds: Set<number>
): Promise<Map<number, number[]>> => {
  const clinicAdmins = await db.user.findMany({
    where: {
      clinicId: { in: Array.from(clinicIds) },
      role: "CLINIC_ADMIN",
      status: "ACTIVE",
    },
    select: {
      id: true,
      clinicId: true,
    },
  });

  const adminsByClinic = new Map<number, number[]>();
  for (const admin of clinicAdmins) {
    if (admin.clinicId) {
      const existing = adminsByClinic.get(admin.clinicId) ?? [];
      existing.push(admin.id);
      adminsByClinic.set(admin.clinicId, existing);
    }
  }
  return adminsByClinic;
};

const groupTimesheetsByClinicAndUser = (
  timesheets: TimesheetWithUser[]
): Map<string, TimesheetWithUser[]> => {
  const grouped = new Map<string, TimesheetWithUser[]>();
  for (const ts of timesheets) {
    const key = `${ts.clinicId}-${ts.userId}`;
    const existing = grouped.get(key) ?? [];
    existing.push(ts);
    grouped.set(key, existing);
  }
  return grouped;
};

const createNotificationMessage = (
  userName: string,
  daysUntilExpiry: number
): string => {
  if (daysUntilExpiry === 0) {
    return `Timesheet for ${userName} expires today. Please renew it.`;
  }
  return `Timesheet for ${userName} expires in ${daysUntilExpiry} day${daysUntilExpiry > 1 ? "s" : ""}. Please renew it.`;
};

const sendNotificationsToAdmins = async (
  adminIds: number[],
  message: string
): Promise<number> => {
  let sent = 0;
  for (const adminId of adminIds) {
    try {
      await db.notification.create({
        data: {
          userId: adminId,
          title: "Timesheet Expiring Soon",
          message,
          type: "TIMESHEET_EXPIRING",
        },
      });
      sent++;
    } catch (error) {
      logger.error("Failed to create notification", {
        adminId,
        error,
      });
    }
  }
  return sent;
};

/**
 * Check for expiring timesheets and send notifications to clinic admins
 * @param daysBeforeExpiry - Number of days before expiry to send notification (default: 2)
 * @returns Number of notifications sent
 */
export async function checkAndNotifyExpiringTimesheets(
  daysBeforeExpiry = 2
): Promise<number> {
  try {
    const todayStart = startOfDay(new Date());
    const expiryThreshold = startOfDay(addDays(todayStart, daysBeforeExpiry));
    const tomorrowStart = startOfDay(addDays(todayStart, 1));

    const expiringTimesheets = await db.staffTimesheet.findMany({
      where: {
        isActive: true,
        endDate: {
          gte: tomorrowStart,
          lte: expiryThreshold,
        },
        ...(TIMESHEETS_GOLIVE ? { createdAt: { gte: TIMESHEETS_GOLIVE } } : {}),
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            clinicId: true,
          },
        },
        clinic: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (expiringTimesheets.length === 0) {
      logger.info("No expiring timesheets found");
      return 0;
    }

    const clinicIds = new Set(expiringTimesheets.map((ts) => ts.clinicId));
    const adminsByClinic = await buildAdminsByClinicMap(clinicIds);
    const timesheetsByClinicAndUser =
      groupTimesheetsByClinicAndUser(expiringTimesheets);

    let notificationsSent = 0;

    for (const [key, timesheets] of timesheetsByClinicAndUser) {
      const [clinicIdStr] = key.split("-");
      const clinicId = Number.parseInt(clinicIdStr, 10);
      const admins = adminsByClinic.get(clinicId) ?? [];

      if (admins.length === 0) {
        logger.warn(`No clinic admins found for clinic ${clinicId}`);
        continue;
      }

      const firstTimesheet = timesheets[0];
      const userName = firstTimesheet.user.name;
      const endDate = startOfDay(firstTimesheet.endDate);
      const daysUntilExpiry = Math.floor(
        (endDate.getTime() - todayStart.getTime()) / (1000 * 60 * 60 * 24)
      );

      const message = createNotificationMessage(userName, daysUntilExpiry);
      const sent = await sendNotificationsToAdmins(admins, message);
      notificationsSent += sent;
    }

    logger.info(`Sent ${notificationsSent} timesheet expiration notifications`);
    return notificationsSent;
  } catch (error) {
    logger.error("Failed to check and notify expiring timesheets", { error });
    throw error;
  }
}
