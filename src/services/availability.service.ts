import {
  addMinutes,
  endOfDay,
  format,
  isBefore,
  parse,
  setMilliseconds,
  setMinutes,
  setSeconds,
  startOfDay,
} from "date-fns";
import { db } from "@/database/db";

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
      if (
        slotMinutes >= 60 &&
        currentTime.getMinutes() !== 0 &&
        isBefore(currentTime, window.end)
      ) {
        currentTime = setMinutes(
          setSeconds(setMilliseconds(currentTime, 0), 0),
          0
        );
      }
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
        let endTime = parse(shift.endTime, "HH:mm", date);

        // Handle cross-midnight shifts (e.g., 22:00-06:00)
        // If endTime < startTime, it spans to next day
        // But we only include times within the target day
        if (isBefore(endTime, startTime)) {
          // Cross-midnight: clamp end to end of day
          endTime = endOfTargetDay;
        }

        const clamped = clampToDay({ start: startTime, end: endTime }, date);
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
