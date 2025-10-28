import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { invalidateVisitRelatedCaches } from "@/lib/cache-utils";
import {
  ActivityType,
  AppointmentType,
  type Event,
  EventType,
} from "../../../../../generated/prisma";
import { db } from "../../../../database/db";
import { logActivity } from "../../../../helpers/activity-helpers";
import { httpCodes } from "../../../../lib/constants";
import type {
  CreatePrescription,
  UpdatePrescription,
  UpdateSpectaclePrescription,
} from "../visits.validation";

export const createPrescription = async (c: Context) => {
  try {
    const user = c.get("user");
    const { prescription, visitId, doctorId, followUpAppointment } = c.get(
      "validatedJson"
    ) as CreatePrescription;
    const items = prescription.items;
    const visitIdNum = visitId;
    const doctorIdNum = doctorId;
    if (!(Number.isFinite(visitIdNum) && Number.isFinite(doctorIdNum))) {
      return c.json(
        { error: "Invalid visitId or doctorId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const visit = await db.visit.findUnique({
      where: {
        id: visitIdNum,
      },
      select: {
        id: true,
        status: true,
        patientInsurance: {
          select: {
            id: true,
            insuranceCompany: {
              select: {
                companyName: true,
              },
            },
          },
        },
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    const result = await db.$transaction(async (tx) => {
      const newPrescription = await tx.prescription.create({
        data: {
          clinicId: user.clinicId,
          doctorId: doctorIdNum,
          visitId: visitIdNum,
          items: {
            create: items.map(
              (item: CreatePrescription["prescription"]["items"][number]) => ({
                medicationName: item.medicationName,
                dosage: item.dosage,
                frequency: item.frequency,
                duration: item.duration,
                instructions: item.instructions,
              })
            ),
          },
        },
      });
      // Create follow-up appointment if needed
      let appointment: Event | undefined;
      if (followUpAppointment) {
        appointment = await tx.event.create({
          data: {
            type: EventType.APPOINTMENT,
            startTime: new Date(followUpAppointment.startTime),
            endTime: new Date(followUpAppointment.endTime),
            treatment: followUpAppointment.treatment,
            appointmentType: AppointmentType.FOLLOW_UP,
            doctor: {
              connect: {
                id: doctorIdNum,
              },
            },
            clinic: {
              connect: {
                id: user.clinicId,
              },
            },
            patient: {
              connect: {
                id: visit.patient.id,
              },
            },
            title: `Follow-up: ${visit.patient.firstName} ${visit.patient.lastName}`,
            visit: {
              connect: {
                id: visit.id,
              },
            },
          },
        });
        if (!appointment) {
          throw new Error("Failed to create follow-up appointment!");
        }
      }

      return { newPrescription, appointment };
    });

    await logActivity({
      userId: user.id,
      visitId: visit.id,
      action: `Prescription created for ${visit.patient.firstName} ${visit.patient.lastName}`,
      type: ActivityType.STATUS_UPDATE,
    });
    await invalidateVisitRelatedCaches({
      visitId: visit.id,
      clinicId: user.clinicId,
      branchId: user.branchId,
    });

    return c.json(
      { success: "Prescription created successfully!", data: result },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to create prescription",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updatePrescription = async (c: Context) => {
  try {
    const user = c.get("user");
    const prescriptionId = Number(c.req.param("prescriptionId"));
    if (!Number.isFinite(prescriptionId)) {
      return c.json(
        { error: "Invalid prescriptionId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const { items } = c.get("validatedJson") as UpdatePrescription;
    const prescription = await db.prescription.findUnique({
      where: {
        id: prescriptionId,
      },
    });
    if (!prescription) {
      return c.json(
        { error: "Prescription not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    const result = await db.$transaction(async (tx) => {
      const updatedPrescription = await tx.prescription.update({
        where: { id: prescriptionId },
        data: {
          items: {
            update: items.map((item) => ({
              where: { id: item.id },
              data: {
                medicationName: item.medicationName,
                dosage: item.dosage,
                frequency: item.frequency,
                duration: item.duration,
                instructions: item.instructions,
              },
            })),
          },
        },
      });
      return updatedPrescription;
    });
    await invalidateVisitRelatedCaches({
      visitId: prescription.visitId,
      clinicId: user.clinicId,
      branchId: user.branchId,
    });
    return c.json(
      { success: "Prescription updated successfully!", data: result },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to update prescription",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const createSpectaclePrescription = async (c: Context) => {
  try {
    const user = c.get("user");
    const validatedData = c.get("validatedJson");
    const { prescription, visitId, doctorId } = validatedData;
    const visitIdNum = Number(visitId);
    const doctorIdNum = Number(doctorId);
    if (!(Number.isFinite(visitIdNum) && Number.isFinite(doctorIdNum))) {
      return c.json(
        { error: "Invalid visitId or doctorId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const visit = await db.visit.findUnique({
      where: {
        id: visitIdNum,
      },
      select: {
        id: true,
        status: true,
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const result = await db.$transaction(async (tx) => {
      const newSpectaclePrescription = await tx.spectaclePrescription.create({
        data: {
          branchId: user.branchId,
          doctorId: doctorIdNum,
          visitId: visitIdNum,
          rightEye: prescription.rightEye,
          leftEye: prescription.leftEye,
          interpupillaryDistance: prescription.interpupillaryDistance,
          lensType: prescription.lensType,
        },
      });
      return newSpectaclePrescription;
    });
    await logActivity({
      userId: doctorId,
      visitId: visit.id,
      action: `Spectacle prescription created for ${visit.patient.firstName} ${visit.patient.lastName}`,
      type: ActivityType.SPECTACLE_PRESCRIPTION_CREATED,
    });
    await invalidateVisitRelatedCaches({
      visitId: visit.id,
      clinicId: user.clinicId,
      branchId: user.branchId,
    });

    return c.json(
      {
        success: true,
        message: "Spectacle prescription created successfully!",
        spectaclePrescription: result,
      },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to create spectacle prescription",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updateSpectaclePrescription = async (c: Context) => {
  try {
    const prescriptionId = Number(c.req.param("prescriptionId"));
    if (!Number.isFinite(prescriptionId)) {
      return c.json(
        { error: "Invalid prescriptionId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const { prescription } = c.get(
      "validatedJson"
    ) as UpdateSpectaclePrescription;

    const existingPrescription = await db.spectaclePrescription.findUnique({
      where: { id: prescriptionId },
    });
    if (!existingPrescription) {
      return c.json(
        { error: "Spectacle prescription not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    const result = await db.spectaclePrescription.update({
      where: { id: prescriptionId },
      data: {
        rightEye: prescription.rightEye,
        leftEye: prescription.leftEye,
        interpupillaryDistance: prescription.interpupillaryDistance,
        lensType: prescription.lensType,
      },
    });

    return c.json(
      {
        success: true,
        message: "Spectacle prescription updated successfully!",
        spectaclePrescription: result,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to update spectacle prescription",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
