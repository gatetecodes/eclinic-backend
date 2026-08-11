import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { invalidateVisitRelatedCaches } from "@/lib/cache-utils";
import {
  ActivityType,
  AppointmentType,
  type Event,
  EventType,
  PrescriptionItemFulfilment,
} from "../../../../../generated/prisma/client";
import { db } from "../../../../database/db";
import { logActivity } from "../../../../helpers/activity-helpers";
import { httpCodes } from "../../../../lib/constants";
import { enqueueCurrentClinicalEventsInTransaction } from "../../../../services/hie/outbox.service";
import type {
  CreatePrescription,
  UpdatePrescription,
  UpdateSpectaclePrescription,
} from "../visits.validation";

// Returns the subset of the requested inventory item ids that actually belong
// to the given clinic, so prescription mappings can never point at another
// clinic's stock.
async function resolveClinicInventoryIds(
  clinicId: number,
  inventoryItemIds: number[]
): Promise<Set<number>> {
  if (inventoryItemIds.length === 0) {
    return new Set();
  }
  const rows = await db.inventoryItem.findMany({
    where: { clinicId, id: { in: inventoryItemIds } },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}

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
        branchId: true,
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
    const resolvedBranchId = visit.branchId ?? user.branchId ?? null;

    // Validate that every internal medication points at an inventory item that
    // actually belongs to this clinic before we create any mappings.
    const requestedInventoryIds = Array.from(
      new Set(
        items
          .map((item) => item.inventoryItemId)
          .filter((id): id is number => typeof id === "number")
      )
    );
    const validInventoryIds = await resolveClinicInventoryIds(
      user.clinicId,
      requestedInventoryIds
    );
    const invalidInternalItem = items.find(
      (item) =>
        item.fulfilment === PrescriptionItemFulfilment.INTERNAL &&
        typeof item.inventoryItemId === "number" &&
        !validInventoryIds.has(item.inventoryItemId)
    );
    if (invalidInternalItem) {
      return c.json(
        {
          error: `Inventory item not found in this clinic for "${invalidInternalItem.medicationName}"`,
        },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const result = await db.$transaction(async (tx) => {
      const newPrescription = await tx.prescription.create({
        data: {
          clinicId: user.clinicId,
          branchId: resolvedBranchId,
          doctorId: doctorIdNum,
          visitId: visitIdNum,
          items: {
            create: items.map(
              (item: CreatePrescription["prescription"]["items"][number]) => {
                const linkInventory =
                  item.fulfilment === PrescriptionItemFulfilment.INTERNAL &&
                  typeof item.inventoryItemId === "number" &&
                  validInventoryIds.has(item.inventoryItemId);
                return {
                  medicationName: item.medicationName,
                  dosage: item.dosage,
                  frequency: item.frequency,
                  duration: item.duration,
                  doseValue: item.doseValue,
                  doseUnit: item.doseUnit,
                  frequencyCount: item.frequencyCount,
                  frequencyPeriod: item.frequencyPeriod,
                  frequencyPeriodUnit: item.frequencyPeriodUnit,
                  routeSystem: item.routeSystem,
                  routeCode: item.routeCode,
                  routeDisplay: item.routeDisplay,
                  methodSystem: item.methodSystem,
                  methodCode: item.methodCode,
                  methodDisplay: item.methodDisplay,
                  durationValue: item.durationValue,
                  durationUnit: item.durationUnit,
                  instructions: item.instructions,
                  fulfilment: item.fulfilment,
                  quantity:
                    item.fulfilment === PrescriptionItemFulfilment.INTERNAL
                      ? (item.quantity ?? null)
                      : null,
                  ...(linkInventory
                    ? {
                        pharmacyItemMap: {
                          create: {
                            inventoryItemId: item.inventoryItemId as number,
                            clinicId: user.clinicId,
                          },
                        },
                      }
                    : {}),
                };
              }
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

      await enqueueCurrentClinicalEventsInTransaction(tx, {
        clinicId: user.clinicId,
        visitId: visit.id,
        patientId: visit.patient.id,
      });

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
      branchId: resolvedBranchId,
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

    const requestedInventoryIds = Array.from(
      new Set(
        items
          .map((item) => item.inventoryItemId)
          .filter((id): id is number => typeof id === "number")
      )
    );
    const validInventoryIds = await resolveClinicInventoryIds(
      prescription.clinicId,
      requestedInventoryIds
    );
    const invalidInternalItem = items.find(
      (item) =>
        item.fulfilment === PrescriptionItemFulfilment.INTERNAL &&
        typeof item.inventoryItemId === "number" &&
        !validInventoryIds.has(item.inventoryItemId)
    );
    if (invalidInternalItem) {
      return c.json(
        {
          error: `Inventory item not found in this clinic for "${invalidInternalItem.medicationName}"`,
        },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const result = await db.$transaction(async (tx) => {
      for (const item of items) {
        await tx.prescriptionItem.update({
          where: { id: item.id },
          data: {
            medicationName: item.medicationName,
            dosage: item.dosage,
            frequency: item.frequency,
            duration: item.duration,
            doseValue: item.doseValue,
            doseUnit: item.doseUnit,
            frequencyCount: item.frequencyCount,
            frequencyPeriod: item.frequencyPeriod,
            frequencyPeriodUnit: item.frequencyPeriodUnit,
            routeSystem: item.routeSystem,
            routeCode: item.routeCode,
            routeDisplay: item.routeDisplay,
            methodSystem: item.methodSystem,
            methodCode: item.methodCode,
            methodDisplay: item.methodDisplay,
            durationValue: item.durationValue,
            durationUnit: item.durationUnit,
            instructions: item.instructions,
            fulfilment: item.fulfilment,
            quantity:
              item.fulfilment === PrescriptionItemFulfilment.INTERNAL
                ? (item.quantity ?? null)
                : null,
          },
        });

        const linkInventory =
          item.fulfilment === PrescriptionItemFulfilment.INTERNAL &&
          typeof item.inventoryItemId === "number" &&
          validInventoryIds.has(item.inventoryItemId);
        if (linkInventory) {
          await tx.pharmacyPrescriptionItemMap.upsert({
            where: { prescriptionItemId: item.id },
            create: {
              prescriptionItemId: item.id,
              inventoryItemId: item.inventoryItemId as number,
              clinicId: prescription.clinicId,
            },
            update: { inventoryItemId: item.inventoryItemId as number },
          });
        } else {
          // External (or internal-without-stock) lines must not retain a stale
          // inventory mapping from a previous edit.
          await tx.pharmacyPrescriptionItemMap.deleteMany({
            where: { prescriptionItemId: item.id },
          });
        }
      }

      return tx.prescription.findUnique({
        where: { id: prescriptionId },
        include: { items: true },
      });
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
