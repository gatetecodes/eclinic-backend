import {
  addMinutes,
  endOfDay,
  format,
  isBefore,
  parse,
  startOfDay,
} from "date-fns";
import { db } from "@/database/db";
import { getUserAvailability } from "@/services/availability.service";

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

export const getDoctorAvailability = async (doctorId: number, date: Date) => {
  try {
    if (!Number.isInteger(doctorId)) {
      throw new Error("doctorId must be a valid integer");
    }
    // Compute availability from unified staff timesheets and filter out booked doctor events
    const { availableTimes: rawTimes } = await getUserAvailability({
      userId: doctorId,
      date,
      slotMinutes: 60,
    });
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
    const availableTimes = rawTimes.filter((t) => !bookedTimes.has(t)).sort();
    return { availableTimes };
  } catch (_error) {
    return { availableTimes: [] };
  }
};
