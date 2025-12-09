import {
  addDays,
  addMinutes,
  endOfDay,
  format,
  isBefore,
  parse,
  startOfDay,
} from "date-fns";
import { db } from "@/database/db";
import type {
  StaffScheduleException,
  StaffShift,
  StaffTimesheet,
} from "../../generated/prisma/client";
import { TIMESHEETS_GOLIVE } from "../lib/timesheets-config";

type GetUserAvailabilityParams = {
  userId: number;
  date: Date;
  branchId?: number;
  slotMinutes?: number;
};

type TimeWindow = {
  start: Date;
  end: Date;
};

function clampToDay(window: TimeWindow, date: Date): TimeWindow {
  const startOfTargetDay = startOfDay(date);
  const endOfTargetDay = endOfDay(date);
  return {
    start: new Date(
      Math.max(window.start.getTime(), startOfTargetDay.getTime())
    ),
    end: new Date(Math.min(window.end.getTime(), endOfTargetDay.getTime())),
  };
}

function* iterateSlots(
  window: TimeWindow,
  slotMinutes: number
): Generator<string> {
  let currentTime = window.start;
  if (isBefore(currentTime, window.end)) {
    while (isBefore(currentTime, window.end)) {
      const timeSlot = format(currentTime, "HH:mm");
      yield timeSlot;
      currentTime = addMinutes(currentTime, slotMinutes);
    }
  }
}

//biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
export async function getUserAvailability({
  userId,
  date,
  branchId,
  slotMinutes = 60,
}: GetUserAvailabilityParams): Promise<{ availableTimes: string[] }> {
  try {
    const targetDay = date.getDay();
    const startOfTargetDay = startOfDay(date);
    const endOfTargetDay = endOfDay(date);

    // Find active timesheets that cover this date
    const activeTimesheets = await db.staffTimesheet.findMany({
      where: {
        userId,
        isActive: true,
        startDate: { lte: endOfTargetDay },
        endDate: { gte: startOfTargetDay },
        ...(TIMESHEETS_GOLIVE ? { createdAt: { gte: TIMESHEETS_GOLIVE } } : {}),
      },
      include: { shifts: true, exceptions: true },
    });

    if (activeTimesheets.length === 0) {
      return { availableTimes: [] };
    }

    const availableTimesSet = new Set<string>();

    for (const ts of activeTimesheets) {
      // Check for date-specific exception
      const exception = ts.exceptions.find((ex) => {
        const exDate = startOfDay(new Date(ex.date));
        return exDate.getTime() === startOfTargetDay.getTime();
      });

      if (exception) {
        if (!exception.isWorking) {
          // Entire day off for this timesheet
          continue;
        }
        if (exception.startTime && exception.endTime) {
          // Override: use exception times
          const startTime = parse(exception.startTime, "HH:mm", date);
          let endTime = parse(exception.endTime, "HH:mm", date);
          if (isBefore(endTime, startTime)) {
            endTime = addMinutes(endTime, 24 * 60);
          }
          const clamped = clampToDay({ start: startTime, end: endTime }, date);
          for (const slot of iterateSlots(clamped, slotMinutes)) {
            availableTimesSet.add(slot);
          }
          continue;
        }
      }

      // No exception, evaluate shifts that apply to this day
      for (const shift of ts.shifts) {
        if (!Array.isArray(shift.daysOfWeek) || shift.daysOfWeek.length === 0) {
          continue;
        }
        // Branch filter
        if (branchId && shift.branchId && shift.branchId !== branchId) {
          continue;
        }

        // Check if this shift applies to the target day
        if (!shift.daysOfWeek.includes(targetDay)) {
          continue;
        }

        // Build time window for this shift on this date
        const startTime = parse(shift.startTime, "HH:mm", date);

        const endTime = parse(shift.endTime, "HH:mm", date);

        const crossesMidnight = isBefore(endTime, startTime);

        const previousDay = (targetDay + 6) % 7;

        const window =
          crossesMidnight && shift.daysOfWeek.includes(previousDay)
            ? { start: startOfTargetDay, end: endTime }
            : {
                start: startTime,
                end: crossesMidnight ? endOfTargetDay : endTime,
              };
        const clamped = clampToDay(window, date);
        for (const slot of iterateSlots(clamped, slotMinutes)) {
          availableTimesSet.add(slot);
        }
      }
    }

    const availableTimes = Array.from(availableTimesSet).sort();
    return { availableTimes };
  } catch (_error) {
    return { availableTimes: [] };
  }
}

export type WeeklyWindow = {
  start: string;
  end: string;
  crossesMidnight: boolean;
  branchId: number | null;
  sourceTimesheetId: number;
  isExceptionOverride: boolean;
};

export type WeeklyDay = {
  dayOfWeek: number;
  windows: WeeklyWindow[];
};

type TimesheetWithRelations = StaffTimesheet & {
  shifts: StaffShift[];
  exceptions: StaffScheduleException[];
};

export async function buildEffectiveWeeklyTimesheet(
  userId: number,
  weekStart: Date,
  preloadedTimesheets?: TimesheetWithRelations[]
): Promise<WeeklyDay[]> {
  const start = startOfDay(weekStart);
  const end = endOfDay(addDays(start, 6));

  const timesheets =
    preloadedTimesheets ??
    (await db.staffTimesheet.findMany({
      where: {
        userId,
        isActive: true,
        startDate: { lte: end },
        endDate: { gte: start },
        ...(TIMESHEETS_GOLIVE ? { createdAt: { gte: TIMESHEETS_GOLIVE } } : {}),
      },
      include: { shifts: true, exceptions: true },
    }));

  if (timesheets.length === 0) {
    return Array.from({ length: 7 }, (_, offset) => {
      const dayDate = addDays(start, offset);
      return {
        dayOfWeek: dayDate.getDay(),
        windows: [],
      };
    });
  }

  //biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
  return Array.from({ length: 7 }, (_, offset) => {
    const dayDate = addDays(start, offset);
    const targetDay = dayDate.getDay();

    const windowsMap = new Map<string, WeeklyWindow>();

    for (const sheet of timesheets) {
      const exception = sheet.exceptions.find((ex) => {
        const exceptionDate = startOfDay(new Date(ex.date));
        return exceptionDate.getTime() === startOfDay(dayDate).getTime();
      });

      if (exception) {
        if (!exception.isWorking) {
          continue;
        }
        if (exception.startTime && exception.endTime) {
          const startTime = exception.startTime;
          const endTime = exception.endTime;
          const parsedStart = parse(startTime, "HH:mm", dayDate);
          let parsedEnd = parse(endTime, "HH:mm", dayDate);
          let crossesMidnight = false;

          if (isBefore(parsedEnd, parsedStart)) {
            parsedEnd = addDays(parsedEnd, 1);
            crossesMidnight = true;
          }

          const key = `${startTime}-${endTime}-${sheet.id}-exception`;
          if (!windowsMap.has(key)) {
            windowsMap.set(key, {
              start: startTime,
              end: endTime,
              crossesMidnight,
              branchId: exception.branchId ?? null,
              sourceTimesheetId: sheet.id,
              isExceptionOverride: true,
            });
          }
          continue;
        }
      }

      for (const shift of sheet.shifts) {
        if (!Array.isArray(shift.daysOfWeek) || shift.daysOfWeek.length === 0) {
          continue;
        }
        if (!shift.daysOfWeek.includes(targetDay)) {
          continue;
        }

        const startTime = shift.startTime;
        const endTime = shift.endTime;
        const parsedStart = parse(startTime, "HH:mm", dayDate);
        let parsedEnd = parse(endTime, "HH:mm", dayDate);
        let crossesMidnight = false;

        if (isBefore(parsedEnd, parsedStart)) {
          parsedEnd = addDays(parsedEnd, 1);
          crossesMidnight = true;
        }

        const key = `${startTime}-${endTime}-${sheet.id}-${shift.id}`;
        if (!windowsMap.has(key)) {
          windowsMap.set(key, {
            start: startTime,
            end: endTime,
            crossesMidnight,
            branchId: shift.branchId ?? null,
            sourceTimesheetId: sheet.id,
            isExceptionOverride: false,
          });
        }
      }
    }

    return {
      dayOfWeek: targetDay,
      windows: Array.from(windowsMap.values()).sort((a, b) =>
        a.start.localeCompare(b.start)
      ),
    };
  });
}
