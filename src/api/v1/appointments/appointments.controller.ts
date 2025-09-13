import { type Context } from "hono";
import { z } from "zod";
import { db } from "../../../database/db";
import type {
  CreateEventInput,
  UpdateScheduleInput,
} from "./appointments.validation.ts";
import { eventSchema, scheduleSchema } from "./appointments.validation.ts";
import {
  addMinutes,
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
  addMonths,
} from "date-fns";
import type { EventType, Gender, Prisma } from "../../../../generated/prisma";

export const getDoctorAvailability = async (c: Context) => {
  try {
    const query = z.object({
      doctorId: z.coerce.number(),
      date: z.coerce.date(),
    });
    const parsed = query.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { doctorId, date } = parsed.data;

    const targetDay = date.getDay();
    const prevDay = subDays(date, 1).getDay();

    const potentialSchedules = await db.doctorAvailability.findMany({
      where: {
        doctorId,
        OR: [{ startDayOfWeek: targetDay }, { startDayOfWeek: prevDay }],
      },
    });
    if (potentialSchedules.length === 0)
      return c.json({ data: { availableTimes: [] } });

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
      existingAppointments.map((a) => format(a.startTime, "HH:mm")),
    );

    const availableTimesSet = new Set<string>();
    for (const schedule of potentialSchedules) {
      if (
        schedule.startDayOfWeek == null ||
        schedule.endDayOfWeek == null ||
        schedule.startTime == null ||
        schedule.endTime == null
      )
        continue;
      const scheduleStartDate = subDays(
        date,
        targetDay - schedule.startDayOfWeek,
      );
      const scheduleEndDate = subDays(date, targetDay - schedule.endDayOfWeek);
      const startTime = parse(
        schedule.startTime as string,
        "HH:mm",
        scheduleStartDate,
      );
      let endTime = parse(schedule.endTime as string, "HH:mm", scheduleEndDate);
      if (isBefore(endTime, startTime)) endTime = addMinutes(endTime, 24 * 60);
      const effectiveStartTime = new Date(
        Math.max(startTime.getTime(), startOfTargetDay.getTime()),
      );
      const effectiveEndTime = new Date(
        Math.min(endTime.getTime(), endOfTargetDay.getTime()),
      );
      let currentTime = effectiveStartTime;
      if (isBefore(currentTime, effectiveEndTime)) {
        while (isBefore(currentTime, effectiveEndTime)) {
          if (currentTime.getMinutes() === 0) {
            const timeSlot = format(currentTime, "HH:mm");
            if (!bookedTimes.has(timeSlot)) availableTimesSet.add(timeSlot);
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
                  0,
                ),
                0,
              ),
              0,
            );
          }
        }
      }
    }

    const availableTimes = Array.from(availableTimesSet).sort();
    return c.json({ data: { availableTimes } });
  } catch (error) {
    console.error("getDoctorAvailability error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};

export const updateDoctorAvailability = async (c: Context) => {
  try {
    const doctorId = Number(c.req.param("doctorId"));
    const json = await c.req.json();
    const parsed = scheduleSchema.safeParse(json as UpdateScheduleInput);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const scheduleByDay = parsed.data.reduce(
      (acc, slot) => {
        if (!acc[slot.dayOfWeek])
          acc[slot.dayOfWeek] = [] as UpdateScheduleInput;
        acc[slot.dayOfWeek]!.push(slot);
        return acc;
      },
      {} as Record<number, UpdateScheduleInput | undefined>,
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
  } catch (error) {
    console.error("updateDoctorAvailability error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};

export const createEvent = async (c: Context) => {
  try {
    const user = c.get("user");
    const json = await c.req.json();
    const parsed = eventSchema.safeParse(json as CreateEventInput);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const {
      doctorId,
      type,
      startTime,
      endTime,
      title,
      description,
      treatment,
      patient,
    } = parsed.data;

    let data: Prisma.EventCreateInput = {
      type: type as EventType,
      startTime,
      endTime,
      doctor: { connect: { id: doctorId } },
      clinic: { connect: { id: user.clinic.id } },
      branch: { connect: { id: user.branch.id } },
    };
    if (type === "APPOINTMENT") {
      let patientId = patient?.id;
      if (!patientId) {
        const created = await db.patient.create({
          data: {
            firstName: patient?.firstName || "",
            lastName: patient?.lastName || "",
            phoneNumber: patient?.phoneNumber,
            dateOfBirth: patient?.dateOfBirth
              ? new Date(patient.dateOfBirth)
              : new Date(),
            gender: (patient?.gender as Gender) || "OTHER",
          },
          select: { id: true },
        });
        patientId = created.id;
      }
      data = {
        ...data,
        title:
          `Appointment with ${patient?.firstName ?? ""} ${patient?.lastName ?? ""}`.trim(),
        patient: { connect: { id: patientId } },
        treatment,
      };
    } else {
      data = { ...data, title, description };
    }

    const event = await db.event.create({ data, include: { patient: true } });
    return c.json({ success: true, data: event }, 201);
  } catch (error) {
    console.error("createEvent error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};

export const getDoctorAppointments = async (c: Context) => {
  try {
    const doctorId = Number(c.req.query("doctorId"));
    const startDateStr = c.req.query("startDate");
    const startDate = startDateStr ? new Date(startDateStr) : new Date();
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
    return c.json({ data: { appointments } });
  } catch (error) {
    console.error("getDoctorAppointments error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
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
  } catch (error) {
    console.error("getDoctorWeeklySchedule error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
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
    if (query["doctorId"]) where.doctorId = Number(query["doctorId"]);
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
  } catch (error) {
    console.error("listAppointments error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
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
  } catch (error) {
    console.error("markAppointmentAsCompleted error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
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
  } catch (error) {
    console.error("cancelAppointment error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};
