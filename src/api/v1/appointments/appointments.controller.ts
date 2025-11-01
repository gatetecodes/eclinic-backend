import {
  addMinutes,
  addMonths,
  endOfDay,
  endOfMonth,
  format,
  isBefore,
  parse,
  setMilliseconds,
  setMinutes,
  setSeconds,
  startOfDay,
  startOfMonth,
  subDays,
} from "date-fns";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { buildQueryOptions } from "@/helpers/query-helper.ts";
import { searchParamsSchema } from "@/lib/common-validation.ts";
import { httpCodes } from "@/lib/constants.ts";
import {
  ActivityType,
  type Event,
  EventType,
  type Prisma,
} from "../../../../generated/prisma";
import { db } from "../../../database/db";
import { logActivity } from "../../../helpers/activity-helpers.ts";
import { getOrCreatePatient } from "../../../helpers/visit-helper.ts";
import { invalidateAppointmentRelatedCaches } from "../../../lib/cache-utils.ts";
import {
  DEFAULT_CACHE_TTL,
  getCachedData,
} from "../../../services/redis.service.ts";
import {
  type eventSchema,
  getDoctorAvailabilityParamsSchema,
  type scheduleSchema,
} from "./appointments.validation.ts";

//biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
export const getDoctorAvailability = async (c: Context) => {
  try {
    const parsed = getDoctorAvailabilityParamsSchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    // date is a JavaScript Date object, e.g. 2024-06-01T00:00:00.000Z
    const { doctorId, date } = parsed.data;

    const targetDay = date.getDay();
    const prevDay = subDays(date, 1).getDay();

    const potentialSchedules = await db.doctorAvailability.findMany({
      where: {
        doctorId,
        OR: [{ startDayOfWeek: targetDay }, { startDayOfWeek: prevDay }],
      },
    });
    if (potentialSchedules.length === 0) {
      return c.json({ data: { availableTimes: [] } });
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
    return c.json({
      status: httpCodes.OK,
      message: "Doctor availability fetched successfully",
      data: { availableTimes },
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updateDoctorAvailability = async (c: Context) => {
  try {
    const doctorId = Number(c.req.param("doctorId"));
    const payload = c.get("validatedJson") as z.infer<typeof scheduleSchema>;

    const scheduleByDay = payload.reduce(
      (acc, slot) => {
        if (!acc[slot.dayOfWeek]) {
          acc[slot.dayOfWeek] = [] as z.infer<typeof scheduleSchema>;
        }
        acc[slot.dayOfWeek]?.push(slot);
        return acc;
      },
      {} as Record<number, z.infer<typeof scheduleSchema> | undefined>
    );

    await db.$transaction(async (tx) => {
      const daysToKeep = Object.keys(scheduleByDay).map((d) => Number(d));
      await tx.doctorAvailability.deleteMany({
        where: { doctorId, dayOfWeek: { notIn: daysToKeep } },
      });
      for (const [dayStr, slots] of Object.entries(scheduleByDay)) {
        const day = Number(dayStr);
        await tx.doctorAvailability.deleteMany({
          where: { doctorId, dayOfWeek: day },
        });
        for (const slot of slots ?? []) {
          await tx.doctorAvailability.create({
            data: {
              doctorId,
              dayOfWeek: day,
              startTime: slot.startTime,
              endTime: slot.endTime,
            },
          });
        }
      }
    });

    return c.json({ success: true, message: "Schedule updated successfully." });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const createEvent = async (c: Context) => {
  try {
    const user = c.get("user");
    const payload = c.get("validatedJson");
    const { doctorId, type, startTime, endTime, title, description } =
      payload as z.infer<typeof eventSchema>;

    // For non-appointments, use current user as doctor if doctorId is not provided
    // For appointments, doctorId is required by the schema, so it will always be a number
    const finalDoctorId: number | undefined =
      type === EventType.APPOINTMENT ? (doctorId as number) : undefined;

    let data: Prisma.EventCreateInput = {
      type: type as EventType,
      startTime,
      endTime,
      doctor: finalDoctorId ? { connect: { id: finalDoctorId } } : undefined,
      clinic: { connect: { id: user.clinicId } },
      branch: { connect: { id: user.branchId } },
    };
    if (type === EventType.APPOINTMENT) {
      const { patientId } = await getOrCreatePatient(payload.patient, user);

      data = {
        ...data,
        title:
          `Appointment with ${payload.patient.firstName ?? ""} ${payload.patient.lastName ?? ""}`.trim(),
        patient: { connect: { id: patientId } },
        treatment: payload.treatment,
      };
    } else {
      data = { ...data, title: title ?? "", description: description ?? "" };
    }

    const event = await db.event.create({ data, include: { patient: true } });

    //Invalidate the appointment cache
    await invalidateAppointmentRelatedCaches({
      doctorId: finalDoctorId,
      date: startTime,
    });

    //Log activity
    await logActivity({
      userId: Number(user.id),
      eventId: event.id,
      type: ActivityType.STATUS_UPDATE,
      action: `Appointment scheduled for ${event.patient?.firstName} ${event.patient?.lastName}`,
    });

    return c.json(
      {
        success: true,
        message: "Appointment created successfully",
        data: event,
      },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getDoctorAppointments = async (c: Context) => {
  try {
    const doctorId = Number(c.req.query("doctorId"));
    const startDateStr = c.req.query("startDate");
    const startDate = startDateStr ? new Date(startDateStr) : new Date();
    const start = startOfMonth(startDate);
    const end = endOfMonth(addMonths(startDate, 2));
    const formattedMonth = format(startDate, "yyyy-MM");
    const cacheKey = `doctor:appointments:${doctorId}:${formattedMonth}`;
    const params = searchParamsSchema.parse(c.req.query());
    const queryOptions = buildQueryOptions<Event>(params);
    const { where: _, ...restOptions } = queryOptions;

    const data = await getCachedData(
      cacheKey,
      async () => {
        const appointments = await db.event.findMany({
          ...restOptions,
          where: {
            doctorId,
            startTime: { gte: start, lte: end },
            type: EventType.APPOINTMENT,
          },
          select: {
            title: true,
            startTime: true,
            endTime: true,
            type: true,
            status: true,
            treatment: true,
            patient: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                phoneNumber: true,
              },
            },
            doctor: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: { startTime: "asc" },
        });
        return appointments;
      },
      DEFAULT_CACHE_TTL.SHORT // Short TTL since appointments change frequently
    );
    const totalCount = await db.event.count({
      where: { doctorId, startTime: { gte: start, lte: end } },
    });
    const pageCount = queryOptions.take
      ? Math.ceil(totalCount / queryOptions.take)
      : 0;
    return c.json(
      {
        status: httpCodes.OK,
        message: "Appointments fetched successfully",
        data,
        totalCount,
        pageCount,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal Server Error";
    return c.json(
      { error: message },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getDoctorAppointmentsPublic = async (c: Context) => {
  try {
    const startDateStr = c.req.query("startDate");
    const startDate = startDateStr ? new Date(startDateStr) : new Date();
    const doctorId = Number(c.req.query("doctorId"));
    //Format the date to YYYY-MM for the cache key
    const formattedMonth = format(startDate, "yyyy-MM");
    const cacheKey = `doctor:appointments:public:${doctorId}:${formattedMonth}`;

    const data = await getCachedData(
      cacheKey,
      async () => {
        const start = startOfMonth(startDate);
        const end = endOfMonth(addMonths(startDate, 2));
        const appointments = await db.event.findMany({
          where: { doctorId, startTime: { gte: start, lte: end } },
          select: {
            title: true,
            startTime: true,
            endTime: true,
            type: true,
            status: true,
            treatment: true,
            patient: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                phoneNumber: true,
              },
            },
          },
          orderBy: { startTime: "asc" },
        });
        return { appointments };
      },
      DEFAULT_CACHE_TTL.SHORT // Short TTL since appointments change frequently
    );
    return c.json({ message: "Appointments fetched successfully", data });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getDoctorWeeklySchedule = async (c: Context) => {
  try {
    const doctorId = Number(c.req.param("doctorId"));
    const weeklySchedule = await db.doctorAvailability.findMany({
      where: { doctorId },
      select: {
        startDayOfWeek: true,
        endDayOfWeek: true,
        startTime: true,
        endTime: true,
      },
    });
    return c.json({ data: weeklySchedule });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getAppointments = async (c: Context) => {
  try {
    const user = c.get("user");
    const doctorId = c.req.query("doctorId");

    const params = searchParamsSchema.parse(c.req.query());
    const queryOptions = buildQueryOptions<Event>(params);
    const { where, orderBy, ...restOptions } = queryOptions;

    const appointments = await db.event.findMany({
      ...restOptions,
      where: {
        ...where,
        clinicId: user.clinicId,
        branchId: user.branchId,
        type: "APPOINTMENT",
        doctorId: doctorId ? Number(doctorId) : undefined,
      },
      orderBy: orderBy as Prisma.EventOrderByWithRelationInput,
      select: {
        id: true,
        title: true,
        startTime: true,
        endTime: true,
        treatment: true,
        createdAt: true,
        status: true,
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        doctor: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
    const totalCount = await db.event.count({
      where: {
        ...where,
        clinicId: user.clinicId,
        branchId: user.branchId,
        type: "APPOINTMENT",
        doctorId: doctorId ? Number(doctorId) : undefined,
      },
    });
    const pageCount = queryOptions.take
      ? Math.ceil(totalCount / queryOptions.take)
      : 0;
    return c.json(
      {
        status: httpCodes.OK,
        message: "Appointments fetched successfully",
        data: appointments,
        totalCount,
        pageCount,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal Server Error";
    return c.json(
      { error: message },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const markAppointmentAsCompleted = async (c: Context) => {
  try {
    const appointmentId = Number(c.req.param("id"));
    const appointment = await db.event.update({
      where: { id: appointmentId },
      data: { status: "COMPLETED" },
      select: { id: true },
    });
    return c.json(
      { success: true, data: appointment },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const cancelAppointment = async (c: Context) => {
  try {
    const appointmentId = Number(c.req.param("id"));
    const appointment = await db.event.update({
      where: { id: appointmentId },
      data: { status: "CANCELLED" },
      select: { id: true },
    });
    return c.json({ success: true, data: appointment });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

/**
 * Get available days of the week for a doctor. Public function to be used in the patient portal
 * @param doctorId
 * @returns Array of day numbers (0-6, Sunday-Saturday) that the doctor is available
 */

export const getAvailableDaysByDoctorId = async (c: Context) => {
  try {
    const doctorIdParam = c.req.param("doctorId");

    const doctorId = Number(doctorIdParam);

    if (!Number.isInteger(doctorId)) {
      return c.json(
        { error: "doctorId must be a valid integer" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
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
      return c.json({ data: [] });
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
    return c.json({
      status: httpCodes.OK,
      message: "Available days fetched successfully",
      data: Array.from(availableDays).sort((a, b) => a - b),
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getAvailableTimeSlotsByDoctorId = async (c: Context) => {
  try {
    const doctorIdParam = c.req.param("doctorId");
    const dayOfWeekParam = c.req.query("dayOfWeek");
    const doctorId = Number(doctorIdParam);
    const dayOfWeek = Number(dayOfWeekParam);
    if (
      !(Number.isInteger(doctorId) && Number.isInteger(dayOfWeek)) ||
      dayOfWeek < 0 ||
      dayOfWeek > 6
    ) {
      return c.json(
        { error: "doctorId/dayOfWeek must be valid integers (dayOfWeek 0-6)" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
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
      return c.json({ data: [] });
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
    return c.json({
      data: sortedTimeSlots,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
