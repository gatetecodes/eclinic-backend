import { addDays, endOfDay, parseISO, startOfDay, startOfWeek } from "date-fns";
import { db } from "@/database/db";
import {
  buildEffectiveWeeklyTimesheet,
  type WeeklyDay,
} from "./availability.service";

const TIMESHEETS_GOLIVE_ISO = process.env.TIMESHEETS_GOLIVE_ISO;
const TIMESHEETS_GOLIVE =
  TIMESHEETS_GOLIVE_ISO && !Number.isNaN(Date.parse(TIMESHEETS_GOLIVE_ISO))
    ? new Date(TIMESHEETS_GOLIVE_ISO)
    : undefined;
export const truthyQueryValue = (value?: string) => {
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

export const resolveWeekStartDate = (value?: string) => {
  const defaultStart = startOfDay(startOfWeek(new Date(), { weekStartsOn: 1 }));
  if (!value) {
    return defaultStart;
  }
  const parsed = parseISO(value);
  if (Number.isNaN(parsed.getTime())) {
    return defaultStart;
  }
  return startOfDay(startOfWeek(parsed, { weekStartsOn: 1 }));
};

export const buildNonExpiredTimesheetSet = async (
  userIds: number[]
): Promise<Set<number>> => {
  if (userIds.length === 0) {
    return new Set();
  }

  const todayStart = startOfDay(new Date());
  const timesheets = await db.staffTimesheet.findMany({
    where: {
      userId: { in: userIds },
      isActive: true,
      endDate: { gte: todayStart },
      ...(TIMESHEETS_GOLIVE ? { createdAt: { gte: TIMESHEETS_GOLIVE } } : {}),
    },
    select: { userId: true },
  });

  return new Set(timesheets.map((sheet) => sheet.userId));
};

export const buildWeeklyTimesheetMapForUsers = async (
  userIds: number[],
  weekStartDate?: Date
): Promise<Record<number, WeeklyDay[]>> => {
  if (!weekStartDate || userIds.length === 0) {
    return {};
  }

  const weekEndDate = endOfDay(addDays(weekStartDate, 6));
  const timesheetRecords = await db.staffTimesheet.findMany({
    where: {
      userId: { in: userIds },
      isActive: true,
      startDate: { lte: weekEndDate },
      endDate: { gte: weekStartDate },
      ...(TIMESHEETS_GOLIVE ? { createdAt: { gte: TIMESHEETS_GOLIVE } } : {}),
    },
    include: { shifts: true, exceptions: true },
  });

  type TimesheetRecord = (typeof timesheetRecords)[number];
  const timesheetsByUser = new Map<number, TimesheetRecord[]>();

  for (const sheet of timesheetRecords) {
    const existing = timesheetsByUser.get(sheet.userId);
    if (existing) {
      existing.push(sheet);
    } else {
      timesheetsByUser.set(sheet.userId, [sheet]);
    }
  }

  const summaries = await Promise.all(
    userIds.map(async (userId) => {
      const summary = await buildEffectiveWeeklyTimesheet(
        userId,
        weekStartDate,
        timesheetsByUser.get(userId) ?? []
      );
      return [userId, summary] as const;
    })
  );

  return Object.fromEntries(summaries);
};

const LICENSE_DATE_REGEX = /^(\d{2})\/(\d{2})\/(\d{4})$/;

export const formatLicenseExpiration = (value?: string | null) => {
  if (!value) {
    return null;
  }
  // Handle dd/mm/yyyy format
  const ddmmyyyyMatch = value.match(LICENSE_DATE_REGEX);
  if (ddmmyyyyMatch) {
    const [, day, month, year] = ddmmyyyyMatch;
    return new Date(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10)
    );
  }
  // Fallback to standard Date parsing
  return new Date(value);
};

export const filterValidAvailability = (
  weeklyAvailability?: Array<{
    startDayOfWeek: number;
    endDayOfWeek: number;
    startTime: string;
    endTime: string;
  }> | null
) =>
  weeklyAvailability?.filter(
    (slot) => slot.startTime !== "" && slot.endTime !== ""
  ) ?? [];
