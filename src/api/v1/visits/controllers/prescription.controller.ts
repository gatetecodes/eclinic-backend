import type { Event } from "@prisma/client";
import { ActivityType, AppointmentType, EventType } from "@prisma/client";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { invalidateVisitRelatedCaches } from "@/lib/cache-utils";
import { db } from "../../../../database/db";
import { logActivity } from "../../../../helpers/activity-helpers";
import { httpCodes } from "../../../../lib/constants";
import type {
  CreatePrescription,
  UpdatePrescription,
} from "../visits.validation";

export const createPrescription = async (c: Context) => {
  try {
    const user = c.get("user");
    const validatedData = c.get("validatedJson");
    const { items, visitId, doctorId, followUpAppointment } = validatedData;
    const visit = await db.visit.findUnique({
      where: {
        id: visitId,
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
          clinicId: user.clinic.id,
          doctorId,
          visitId,
          items: {
            create: items.map((item: CreatePrescription["items"][number]) => ({
              medicationName: item.medicationName,
              dosage: item.dosage,
              frequency: item.frequency,
              duration: item.duration,
              instructions: item.instructions,
            })),
          },
        },
      });
      // Create follow-up appointment if needed
      let appointment: Event | undefined;
      if (followUpAppointment) {
        appointment = await tx.event.create({
          data: {
            type: EventType.APPOINTMENT,
            startTime: followUpAppointment.startTime,
            endTime: followUpAppointment.endTime,
            treatment: followUpAppointment.treatment,
            appointmentType: AppointmentType.FOLLOW_UP,
            doctor: {
              connect: {
                id: doctorId,
              },
            },
            clinic: {
              connect: {
                id: user.clinic.id,
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
          return c.json(
            { error: "Failed to create follow-up appointment!" },
            httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
          );
        }
      }

      return { newPrescription, appointment };
    });

    await logActivity({
      userId: doctorId,
      visitId: visit.id,
      action: `Prescription created for ${visit.patient.firstName} ${visit.patient.lastName}`,
      type: ActivityType.STATUS_UPDATE,
    });
    await invalidateVisitRelatedCaches({
      visitId: visit.id,
      clinicId: user.clinic.id,
      branchId: user.branch.id,
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
    const prescriptionId = c.req.param("prescriptionId");
    const validatedData = c.get("validatedJson");
    const { data } = validatedData;
    const prescription = await db.prescription.findUnique({
      where: {
        id: Number(prescriptionId),
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
        where: { id: Number(prescriptionId) },
        data: {
          items: {
            update: data.items.map(
              (item: UpdatePrescription["items"][number]) => ({
                where: { id: item.id },
                data: {
                  medicationName: item.medicationName,
                  dosage: item.dosage,
                  frequency: item.frequency,
                  duration: item.duration,
                  instructions: item.instructions,
                },
              })
            ),
          },
        },
      });
      return updatedPrescription;
    });
    await invalidateVisitRelatedCaches({
      visitId: prescription.visitId,
      clinicId: user.clinic.id,
      branchId: user.branch.id,
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
    const visit = await db.visit.findUnique({
      where: {
        id: visitId,
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
          branchId: user.branch.id,
          doctorId,
          visitId,
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
      clinicId: user.clinic.id,
      branchId: user.branch.id,
    });

    return c.json(
      { success: "Spectacle prescription created successfully!", data: result },
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
    const prescriptionId = c.req.param("prescriptionId");
    const validatedData = c.get("validatedJson");
    const { data } = validatedData;
    const prescription = await db.spectaclePrescription.findUnique({
      where: { id: Number(prescriptionId) },
    });
    if (!prescription) {
      return c.json(
        { error: "Spectacle prescription not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    const result = await db.spectaclePrescription.update({
      where: { id: Number(prescriptionId) },
      data,
    });

    return c.json(
      { success: "Spectacle prescription updated successfully!", data: result },
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
