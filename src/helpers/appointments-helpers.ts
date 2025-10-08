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
  subDays,
} from "date-fns";
import { db } from "@/database/db";

export const getAvailableDaysByDoctorId = async (doctorId: number) => {
  try {
    if (!Number.isInteger(doctorId)) {
      throw new Error("doctorId must be a valid integer");
    }
    const availability = await db.doctorAvailability.findMany({
      where: { doctorId },
      select: {
        startDayOfWeek: true,
        endDayOfWeek: true,
        startTime: true,
        endTime: true,
      },
    });
    if (availability.length === 0) {
      return [];
    }
    const availableDays = new Set<number>();
    for (const schedule of availability) {
      if (schedule.startDayOfWeek !== null && schedule.endDayOfWeek !== null) {
        let currentDay = schedule.startDayOfWeek;
        const endDay = schedule.endDayOfWeek;
        do {
          availableDays.add(currentDay);
          currentDay = (currentDay + 1) % 7;
        } while (currentDay !== (endDay + 1) % 7);
      }
    }
    return Array.from(availableDays).sort((a, b) => a - b);
  } catch (_error) {
    return [];
  }
};

export const getAvailableTimeSlotsByDoctorId = async (
  doctorId: number,
  dayOfWeek: number
) => {
  try {
    if (
      !(Number.isInteger(doctorId) && Number.isInteger(dayOfWeek)) ||
      dayOfWeek < 0 ||
      dayOfWeek > 6
    ) {
      throw new Error(
        "doctorId/dayOfWeek must be valid integers (dayOfWeek 0-6)"
      );
    }

    const availability = await db.doctorAvailability.findMany({
      where: {
        doctorId,
        OR: [
          { startDayOfWeek: dayOfWeek },
          { endDayOfWeek: dayOfWeek },
          {
            AND: [
              { startDayOfWeek: { lte: dayOfWeek } },
              { endDayOfWeek: { gte: dayOfWeek } },
            ],
          },
        ],
      },
      select: {
        startDayOfWeek: true,
        endDayOfWeek: true,
        startTime: true,
        endTime: true,
      },
    });

    if (availability.length === 0) {
      return [];
    }
    const availableTimeSlots = new Set<string>();
    for (const schedule of availability) {
      if (
        schedule.startTime === null ||
        schedule.endTime === null ||
        schedule.startDayOfWeek === null ||
        schedule.endDayOfWeek === null
      ) {
        continue;
      }

      //Parse start and end times
      const startTime = parse(schedule.startTime, "HH:mm", new Date());
      const endTime = parse(schedule.endTime, "HH:mm", new Date());

      //Handle schedules that span multiple days
      let effectiveStartTime = startTime;
      let effectiveEndTime = endTime;

      //If the schedule starts on a different day, adjust start time to beginning of target day
      if (schedule.startDayOfWeek < dayOfWeek) {
        effectiveStartTime = parse("00:00", "HH:mm", new Date());
      }

      //If the schedule ends on a different day, adjust end time to end of target day
      if (schedule.endDayOfWeek > dayOfWeek) {
        effectiveEndTime = parse("23:59", "HH:mm", new Date());
      }

      //Generate 30-minute slots
      let currentTime = effectiveStartTime;

      while (isBefore(currentTime, effectiveEndTime)) {
        const timeSlot = format(currentTime, "HH:mm");
        availableTimeSlots.add(timeSlot);
        currentTime = addMinutes(currentTime, 30);
      }
    }

    //Convert to array and sort
    const sortedTimeSlots = Array.from(availableTimeSlots).sort((a, b) => {
      const timeA = parse(a, "HH:mm", new Date());
      const timeB = parse(b, "HH:mm", new Date());
      return timeA.getTime() - timeB.getTime();
    });
    return sortedTimeSlots;
  } catch (_error) {
    return [];
  }
};

//biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
export const getDoctorAvailability = async (doctorId: number, date: Date) => {
  try {
    if (!Number.isInteger(doctorId)) {
      throw new Error("doctorId must be a valid integer");
    }
    // date is a JavaScript Date object, e.g. 2024-06-01T00:00:00.000Z

    const targetDay = date.getDay();
    const prevDay = subDays(date, 1).getDay();

    const potentialSchedules = await db.doctorAvailability.findMany({
      where: {
        doctorId,
        OR: [{ startDayOfWeek: targetDay }, { startDayOfWeek: prevDay }],
      },
    });
    if (potentialSchedules.length === 0) {
      return { availableTimes: [] };
    }

    const startOfTargetDay = startOfDay(date);
    const endOfTargetDay = endOfDay(date);
    const existingAppointments = await db.event.findMany({
      where: {
        doctorId,
        startTime: { gte: startOfTargetDay, lte: endOfTargetDay },
        type: "APPOINTMENT",
        status: { not: "CANCELLED" },
      },
      select: { startTime: true },
    });
    const bookedTimes = new Set(
      existingAppointments.map((a) => format(a.startTime, "HH:mm"))
    );

    const availableTimesSet = new Set<string>();
    for (const schedule of potentialSchedules) {
      if (
        schedule.startDayOfWeek == null ||
        schedule.endDayOfWeek == null ||
        schedule.startTime == null ||
        schedule.endTime == null
      ) {
        continue;
      }
      const scheduleStartDate = subDays(
        date,
        targetDay - schedule.startDayOfWeek
      );
      const scheduleEndDate = subDays(date, targetDay - schedule.endDayOfWeek);
      const startTime = parse(
        schedule.startTime as string,
        "HH:mm",
        scheduleStartDate
      );
      let endTime = parse(schedule.endTime as string, "HH:mm", scheduleEndDate);
      if (isBefore(endTime, startTime)) {
        endTime = addMinutes(endTime, 24 * 60);
      }
      const effectiveStartTime = new Date(
        Math.max(startTime.getTime(), startOfTargetDay.getTime())
      );
      const effectiveEndTime = new Date(
        Math.min(endTime.getTime(), endOfTargetDay.getTime())
      );
      let currentTime = effectiveStartTime;
      if (isBefore(currentTime, effectiveEndTime)) {
        while (isBefore(currentTime, effectiveEndTime)) {
          if (currentTime.getMinutes() === 0) {
            const timeSlot = format(currentTime, "HH:mm");
            if (!bookedTimes.has(timeSlot)) {
              availableTimesSet.add(timeSlot);
            }
          }
          currentTime = addMinutes(currentTime, 1);
          if (
            currentTime.getMinutes() !== 0 &&
            isBefore(currentTime, effectiveEndTime)
          ) {
            currentTime = setMinutes(
              setSeconds(
                setMilliseconds(
                  addMinutes(currentTime, 60 - currentTime.getMinutes()),
                  0
                ),
                0
              ),
              0
            );
          }
        }
      }
    }

    const availableTimes = Array.from(availableTimesSet).sort();
    return availableTimes;
  } catch (_error) {
    return [];
  }
};
