import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { db } from "@/database/db";
import {
  getAvailableDaysByDoctorId,
  getAvailableTimeSlotsByDoctorId,
  getDoctorAvailability,
} from "@/helpers/appointments-helpers";
import { httpCodes } from "@/lib/constants";
import {
  BranchStatus,
  PatientAppointmentStatus,
  Role,
  SubscriptionStatus,
  UserStatus,
} from "../../../../generated/prisma/client";

export const getAvailableClinics = async (c: Context) => {
  try {
    const clinics = await db.clinic.findMany({
      where: {
        isPatientPortalEnabled: true,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
      },
      include: {
        branches: {
          where: {
            isPatientPortalEnabled: true,
            status: BranchStatus.ACTIVE,
          },
        },
      },
      orderBy: {
        name: "asc",
      },
    });
    return c.json(
      {
        status: httpCodes.OK,
        message: "Available clinics fetched successfully",
        data: clinics,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getAvailableBranches = async (c: Context) => {
  try {
    const { clinicId } = c.get("validatedQuery");
    const branches = await db.branch.findMany({
      where: {
        isPatientPortalEnabled: true,
        status: BranchStatus.ACTIVE,
        clinicId: Number(clinicId),
      },
      orderBy: {
        name: "asc",
      },
    });
    return c.json(
      {
        status: httpCodes.OK,
        message: "Available branches fetched successfully",
        data: branches,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getAvailableDepartments = async (c: Context) => {
  try {
    const { clinicId, branchId } = c.get("validatedQuery");

    const departments = await db.clinicalDepartment.findMany({
      where: {
        isActive: true,
        clinics: { some: { id: Number(clinicId) } },
        branches: { some: { id: Number(branchId) } },
      },
      orderBy: {
        name: "asc",
      },
    });
    return c.json(
      {
        status: httpCodes.OK,
        message: "Available departments fetched successfully",
        data: departments,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getAvailableDoctors = async (c: Context) => {
  try {
    const { clinicId, branchId, departmentId } = c.get("validatedQuery");

    const doctors = await db.user.findMany({
      where: {
        clinicId: Number(clinicId),
        branchId: Number(branchId),
        clinicalDepartments: { some: { id: Number(departmentId) } },
        status: UserStatus.ACTIVE,
        role: Role.DOCTOR,
      },
      select: {
        id: true,
        name: true,
        consultationFee: true,
        doctorAvailabilities: {
          select: {
            startDayOfWeek: true,
            endDayOfWeek: true,
            startTime: true,
            endTime: true,
          },
        },
      },
      orderBy: {
        name: "asc",
      },
    });
    return c.json(
      {
        status: httpCodes.OK,
        message: "Available doctors fetched successfully",
        data: doctors,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getDoctorAvailableDays = async (c: Context) => {
  try {
    const { doctorId } = c.get("validatedParams");

    const result = await getAvailableDaysByDoctorId(Number(doctorId));
    return c.json(
      {
        status: httpCodes.OK,
        message: "Available days fetched successfully",
        data: result,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getDoctorAvailableTimeSlots = async (c: Context) => {
  try {
    const { doctorId, dayOfWeek } = c.get("validatedQuery");

    const result = await getAvailableTimeSlotsByDoctorId(
      Number(doctorId),
      Number(dayOfWeek)
    );
    return c.json(
      {
        status: httpCodes.OK,
        message: "Available time slots fetched successfully",
        data: result,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getDoctorAvailableSlots = async (c: Context) => {
  try {
    const { doctorId, date } = c.get("validatedQuery");

    const { availableTimes } = await getDoctorAvailability(
      Number(doctorId),
      new Date(date)
    );
    return c.json(
      {
        status: httpCodes.OK,
        message: "Available slots fetched successfully",
        data: availableTimes,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const bookPatientAppointment = async (c: Context) => {
  try {
    const data = c.get("validatedJson");
    // If caller is an authenticated PATIENT, derive patientId from session
    const user = c.get("user");
    if (user?.role === "PATIENT") {
      if (!user.patientId) {
        return c.json(
          { error: "Patient profile not linked to this account" },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
      }
      data.patientId = user.patientId;
    }

    const clinic = await db.clinic.findFirst({
      where: {
        id: data.clinicId,
        isPatientPortalEnabled: true,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
      },
    });
    if (!clinic) {
      return c.json(
        { error: "Selected clinic does not support online booking" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    if (data.branchId) {
      const branch = await db.branch.findFirst({
        where: {
          id: data.branchId,
          clinicId: data.clinicId,
          isPatientPortalEnabled: true,
          status: BranchStatus.ACTIVE,
        },
      });
      if (!branch) {
        return c.json(
          { error: "Selected branch does not support online booking" },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
      }
    }
    const appointmentDateTime = new Date(
      `${data.appointmentDate}T${data.startTime}`
    );
    const { availableTimes } = await getDoctorAvailability(
      data.doctorId,
      appointmentDateTime
    );

    if (!availableTimes?.includes(data.startTime)) {
      return c.json(
        { error: "Selected slot is not available" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const existingAppointment = await db.patientAppointment.findFirst({
      where: {
        patientId: data.patientId,
        appointmentDate: appointmentDateTime,
        startTime: data.startTime,
        status: {
          in: [
            PatientAppointmentStatus.PENDING,
            PatientAppointmentStatus.CONFIRMED,
          ],
        },
      },
    });
    if (existingAppointment) {
      return c.json(
        { error: "Selected slot is already booked" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const result = await db.$transaction(async (tx) => {
      const patientAppointment = await tx.patientAppointment.create({
        data: {
          patientId: data.patientId,
          clinicId: data.clinicId,
          branchId: data.branchId,
          departmentId: data.departmentId,
          doctorId: data.doctorId,
          appointmentDate: appointmentDateTime,
          startTime: data.startTime,
          endTime: data.endTime,
          reason: data.reason,
          symptoms: data.symptoms,
          isFollowUp: data.isFollowUp,
          previousVisitId: data.previousVisitId,
        },
      });

      const patient = await tx.patient.findFirst({
        where: { id: data.patientId },
        select: { firstName: true, lastName: true },
      });
      const event = await tx.event.create({
        data: {
          title: `P - ${patient?.firstName} ${patient?.lastName}`,
          startTime: appointmentDateTime,
          endTime: new Date(`${data.appointmentDate}T${data.endTime}`),
          doctorId: data.doctorId,
          clinicId: data.clinicId,
          branchId: data.branchId,
          type: "APPOINTMENT",
          status: "SCHEDULED",
          treatment: data.reason || "Patient portal booking",
        },
      });
      await tx.patientAppointment.update({
        where: { id: patientAppointment.id },
        data: { internalEventId: event.id },
      });
      await tx.patientNotification.create({
        data: {
          patientId: data.patientId,
          title: "Appointment Booked",
          message: `Your appointment has been booked for ${data.appointmentDate} at ${data.startTime}`,
          type: "APPOINTMENT_CONFIRMED",
          relatedAppointmentId: patientAppointment.id,
        },
      });
      return { patientAppointment, event };
    });
    return c.json(
      {
        status: httpCodes.OK,
        message: "Appointment booked successfully",
        data: result,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getPatientAppointments = async (c: Context) => {
  try {
    const { patientId } = c.get("validatedParams");
    const appointments = await db.patientAppointment.findMany({
      where: { patientId: Number(patientId) },
      include: {
        clinic: true,
        branch: true,
        department: true,
        doctor: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: { appointmentDate: "desc" },
    });
    return c.json(
      {
        status: httpCodes.OK,
        message: "Patient appointments fetched successfully",
        data: appointments,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const cancelPatientAppointment = async (c: Context) => {
  try {
    const { appointmentId, patientId } = c.get("validatedParams");

    const appointment = await db.patientAppointment.findFirst({
      where: { id: Number(appointmentId), patientId: Number(patientId) },
    });
    if (!appointment) {
      return c.json(
        { error: "Appointment not found" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    if (
      appointment.status !== PatientAppointmentStatus.PENDING &&
      appointment.status !== PatientAppointmentStatus.CONFIRMED
    ) {
      return c.json(
        { error: "Appointment cannot be cancelled" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const result = await db.$transaction(async (tx) => {
      const updatedAppointment = await tx.patientAppointment.update({
        where: { id: Number(appointmentId) },
        data: { status: PatientAppointmentStatus.CANCELLED },
      });
      if (appointment.internalEventId) {
        await tx.event.update({
          where: { id: appointment.internalEventId },
          data: { status: "CANCELLED" },
        });
      }
      await tx.patientNotification.create({
        data: {
          patientId: Number(patientId),
          title: "Appointment Cancelled",
          message: `Your appointment for ${appointment.appointmentDate} has been cancelled`,
          type: "APPOINTMENT_CANCELLED",
          relatedAppointmentId: Number(appointmentId),
        },
      });
      return updatedAppointment;
    });
    return c.json(
      {
        status: httpCodes.OK,
        message: "Appointment cancelled successfully",
        data: result,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getAppointmentDetails = async (c: Context) => {
  try {
    const { appointmentId, patientId } = c.get("validatedParams");
    const appointment = await db.patientAppointment.findFirst({
      where: { id: Number(appointmentId), patientId: Number(patientId) },
      include: {
        clinic: true,
        branch: true,
        department: true,
        doctor: {
          select: {
            id: true,
            name: true,
            consultationFee: true,
          },
        },
      },
      orderBy: { appointmentDate: "desc" },
    });
    return c.json(
      {
        status: httpCodes.OK,
        message: "Appointment details fetched successfully",
        data: appointment,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
