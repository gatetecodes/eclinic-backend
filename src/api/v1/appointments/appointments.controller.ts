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
import { httpCodes } from "@/lib/constants.ts";
import {
  ActivityType,
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
  eventSchema,
  getDoctorAvailabilityParamsSchema,
  scheduleSchema,
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
    return c.json({ data: { availableTimes } });
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
    const json = await c.req.json();
    const parsed = scheduleSchema.safeParse(json);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const scheduleByDay = parsed.data.reduce(
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
    const json = await c.req.json();
    const parsed = eventSchema.safeParse(json);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten() },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const { doctorId, type, startTime, endTime, title, description } =
      parsed.data;

    let data: Prisma.EventCreateInput = {
      type: type as EventType,
      startTime,
      endTime,
      doctor: { connect: { id: doctorId } },
      clinic: { connect: { id: user.clinic.id } },
      branch: { connect: { id: user.branch.id } },
    };
    if (type === EventType.APPOINTMENT) {
      const { patientId } = await getOrCreatePatient(parsed.data.patient, user);

      data = {
        ...data,
        title:
          `Appointment with ${parsed.data.patient.firstName ?? ""} ${parsed.data.patient.lastName ?? ""}`.trim(),
        patient: { connect: { id: patientId } },
        treatment: parsed.data.treatment,
      };
    } else {
      data = { ...data, title: title ?? "", description: description ?? "" };
    }

    const event = await db.event.create({ data, include: { patient: true } });

    //Invalidate the appointment cache
    await invalidateAppointmentRelatedCaches({ doctorId, date: startTime });

    //Log activity
    await logActivity({
      userId: Number(user.id),
      eventId: event.id,
      type: ActivityType.STATUS_UPDATE,
      action: `Appointment scheduled for ${event.patient?.firstName} ${event.patient?.lastName}`,
    });

    return c.json(
      { success: true, data: event },
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
    const data = await getCachedData(
      cacheKey,
      async () => {
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

export const listAppointments = async (c: Context) => {
  try {
    const user = c.get("user");
    const query = c.req.query();
    const where: Prisma.EventWhereInput = {
      clinicId: Number(user.clinic.id),
      branchId: Number(user.branch.id),
      type: "APPOINTMENT",
    };
    if (query.doctorId) {
      where.doctorId = Number(query.doctorId);
    }
    const appointments = await db.event.findMany({
      where,
      select: {
        id: true,
        title: true,
        startTime: true,
        endTime: true,
        treatment: true,
        createdAt: true,
        status: true,
        patient: { select: { id: true, firstName: true, lastName: true } },
        doctor: { select: { id: true, name: true } },
      },
      orderBy: { startTime: "asc" },
    });
    return c.json({ data: appointments });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
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
    return c.json({ success: true, data: appointment });
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
