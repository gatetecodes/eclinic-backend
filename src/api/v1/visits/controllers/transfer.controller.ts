import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "@/lib/constants";
import { ActivityType, Role } from "../../../../../generated/prisma";
import { db } from "../../../../database/db";
import { logActivity } from "../../../../helpers/activity-helpers";
import { invalidateVisitRelatedCaches } from "../../../../lib/cache-utils";
import { handoffSchema, rejectHandoffBodySchema } from "../visits.validation";

export const initiateHandoff = async (c: Context) => {
  try {
    const user = c.get("user");
    const parsed = handoffSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const { visitId, toDoctorId, handoffNotes } = parsed.data;
    const visit = await db.visit.findUnique({
      where: { id: visitId },
      include: {
        patient: { select: { firstName: true, lastName: true } },
        doctor: { select: { id: true, name: true } },
      },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (visit.doctor?.id !== Number(user.id)) {
      return c.json(
        { error: "You are not authorized to handoff this visit" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const receivingDoctor = await db.user.findFirst({
      where: {
        id: Number(toDoctorId),
        role: Role.DOCTOR,
        status: "ACTIVE",
        clinicId: user.clinic.id,
        branchId: user.branch.id,
      },
    });
    if (!receivingDoctor) {
      return c.json(
        { error: "Receiving doctor not found or inactive" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const handoff = await db.handoff.create({
      data: {
        visitId,
        fromDoctorId: Number(user.id),
        toDoctorId: Number(toDoctorId),
        handoffNotes,
        handoffStatus: "PENDING",
      },
    });
    if (!handoff) {
      return c.json(
        { error: "Failed to create handoff record" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    await db.notification.create({
      data: {
        userId: Number(toDoctorId),
        message: `You have a new handoff request from Dr. ${user.name} for patient ${visit.patient.firstName} ${visit.patient.lastName}`,
        type: "HANDOFF_REQUEST",
        title: "Handoff Request",
        visitId,
      },
    });

    await logActivity({
      userId: Number(user.id),
      visitId,
      type: ActivityType.HANDOFF,
      action: `Dr. ${user.name} initiated handoff to Dr. ${receivingDoctor.name}`,
    });

    return c.json({ success: "Handoff initiated successfully", data: handoff });
  } catch (_error) {
    return c.json(
      { error: "Failed to initiate handoff" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const acceptHandoff = async (c: Context) => {
  try {
    const user = c.get("user");
    const { handoffId } = c.get("validatedParam") ?? (await c.req.param());
    const id = Number.parseInt(handoffId ?? c.req.param("handoffId"), 10);
    const handoff = await db.handoff.findUnique({
      where: { id },
      include: {
        visit: {
          select: {
            id: true,
            clinicId: true,
            branchId: true,
            patient: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });
    if (!handoff) {
      return c.json(
        { error: "Handoff record not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (handoff.handoffStatus !== "PENDING") {
      return c.json(
        { error: "Handoff already processed" },
        httpCodes.CONFLICT as ContentfulStatusCode
      );
    }
    if (handoff.toDoctorId !== Number(user.id)) {
      return c.json(
        { error: "You are not authorized to accept this handoff" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const updatedHandoff = await db.$transaction(async (tx) => {
      await tx.handoff.update({
        where: { id },
        data: { handoffStatus: "ACCEPTED", acceptedAt: new Date() },
      });
      await tx.visit.update({
        where: { id: handoff.visitId },
        data: { doctorId: handoff.toDoctorId },
      });
      return handoff;
    });

    await logActivity({
      userId: Number(user.id),
      visitId: handoff.visitId,
      type: ActivityType.HANDOFF,
      action: `Dr. ${user.name} accepted handoff for patient ${handoff.visit.patient.firstName} ${handoff.visit.patient.lastName}`,
    });

    await invalidateVisitRelatedCaches({
      clinicId: handoff.visit.clinicId,
      branchId: Number(handoff.visit.branchId ?? 0),
      visitId: handoff.visitId,
    });

    return c.json({
      success: "Handoff accepted successfully",
      data: updatedHandoff,
    });
  } catch (_error) {
    return c.json(
      { error: "Failed to accept handoff" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const rejectHandoff = async (c: Context) => {
  try {
    const user = c.get("user");
    const { handoffId } = c.get("validatedParam") ?? c.req.param();
    const id = Number.parseInt(handoffId ?? c.req.param("handoffId"), 10);
    const parsed = rejectHandoffBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const { reason } = parsed.data;
    const handoff = await db.handoff.findUnique({
      where: { id },
      include: {
        visit: {
          include: { patient: { select: { firstName: true, lastName: true } } },
        },
      },
    });
    if (!handoff) {
      return c.json(
        { error: "Handoff record not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (handoff.toDoctorId !== Number(user.id)) {
      return c.json(
        { error: "You are not authorized to reject this handoff" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const result = await db.$transaction(async (tx) => {
      const updatedHandoff = await tx.handoff.update({
        where: { id },
        data: {
          handoffStatus: "REJECTED",
          handoffNotes: `${handoff.handoffNotes}\n\nRejection reason: ${reason}`,
        },
      });
      await logActivity({
        userId: Number(user.id),
        visitId: handoff.visitId,
        type: ActivityType.HANDOFF,
        action: `Dr. ${user.name} rejected handoff for patient ${handoff.visit.patient.firstName} ${handoff.visit.patient.lastName}. Reason: ${reason}`,
      });
      return updatedHandoff;
    });

    return c.json({ success: "Handoff rejected successfully", data: result });
  } catch (_error) {
    return c.json(
      { error: "Failed to reject handoff" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const transferVisitToDoctor = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.get("validatedParam");
    const visitId = Number.parseInt(id, 10);
    const data = c.get("validatedJson") ?? (await c.req.json());

    const visit = await db.visit.findUnique({
      where: { id: visitId },
      select: {
        id: true,
        patient: { select: { firstName: true, lastName: true } },
      },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const doctor = await db.user.findFirst({
      where: {
        AND: {
          id: Number.parseInt(String(data.doctorId), 10),
          role: Role.DOCTOR,
          clinicId: user.clinicId ?? user.clinic.id,
        },
      },
      select: { id: true, name: true, status: true },
    });
    if (!doctor) {
      return c.json(
        { error: "Doctor not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (doctor.status !== "ACTIVE") {
      return c.json(
        { error: "Doctor not currently active" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const updatedVisit = await db.visit.update({
      where: { id: visit.id },
      data: { doctorId: doctor.id },
    });

    await logActivity({
      userId: Number(user.id),
      visitId: visit.id,
      type: ActivityType.STATUS_UPDATE,
      action: `Dr. ${user.name} transferred ${visit.patient.firstName} ${visit.patient.lastName} to Dr. ${doctor.name}`,
    });

    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId ?? user.clinic.id,
      branchId: user.branchId ?? user.branch.id,
      visitId: visit.id,
    });

    return c.json(
      {
        status: httpCodes.OK,
        success: true,
        message: "Visit transferred successfully",
        data: updatedVisit,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
