import { db } from "@/database/db";
import { logger } from "@/lib/logger";
import { QueueEntryStatus, QueueSource } from "../../generated/prisma/client";
import { QueueFlowService } from "./queue-flow.service";
import { WhatsAppService } from "./whatsapp.service";

export const QueueIntegrationService = {
  /**
   * Ensures that a patient joins a doctor's active queue if they are not already in it.
   */
  ensurePatientInDoctorQueue: async (params: {
    doctorId: number;
    patientId: number;
    clinicId: number;
    branchId: number;
  }) => {
    const { doctorId, patientId, clinicId, branchId } = params;

    try {
      // 1. Find an active queue for this doctor in this clinic/branch
      const activeQueue = await db.queue.findFirst({
        where: {
          doctorId,
          clinicId,
          branchId,
          status: "OPEN",
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      if (!activeQueue) {
        logger.info("Auto-queue: No active queue found for doctor", {
          doctorId,
          clinicId,
          branchId,
        });
        return;
      }

      // 2. Get patient details (specifically phone number for identity)
      const patient = await db.patient.findUnique({
        where: { id: patientId },
        select: { phoneNumber: true, firstName: true, lastName: true },
      });

      if (!patient?.phoneNumber) {
        logger.warn("Auto-queue: Patient not found or missing phone number", {
          patientId,
        });
        return;
      }

      // 3. Check if patient is already in this queue (WAITING or NOTIFIED)
      const existingEntry = await db.queueEntry.findFirst({
        where: {
          queueId: activeQueue.id,
          OR: [{ patientId }, { phoneNumber: patient.phoneNumber }],
          status: {
            in: [QueueEntryStatus.WAITING, QueueEntryStatus.NOTIFIED],
          },
        },
      });

      if (existingEntry) {
        logger.info("Auto-queue: Patient already in queue", {
          patientId,
          queueId: activeQueue.id,
          entryId: existingEntry.id,
        });

        // If the entry was joined via WhatsApp but didn't have patientId linked, link it now
        if (!existingEntry.patientId) {
          await db.queueEntry.update({
            where: { id: existingEntry.id },
            data: { patientId },
          });
        }
        return;
      }

      // 4. Join the queue
      const displayName = [patient.firstName, patient.lastName]
        .filter(Boolean)
        .join(" ");

      const entry = await QueueFlowService.joinQueue({
        queueId: activeQueue.id,
        phoneNumber: patient.phoneNumber,
        name: displayName || undefined,
        patientId,
        source: QueueSource.STAFF, // Source is STAFF because it's triggered by clinic check-in
      });

      logger.info("Auto-queue: Patient joined queue successfully", {
        patientId,
        queueId: activeQueue.id,
      });

      // 5. Notify the patient
      const positionInQueue = (entry.waitingAhead ?? 0) + 1;
      const waitTime = entry.estimatedWaitTime ?? 0;

      const message = `Hello ${patient.firstName || "there"}! You've been successfully added to the queue for ${activeQueue.name}.\n\nTicket #${entry.position}\nYou are #${positionInQueue} in line.\nEstimated wait: ${waitTime} mins.\n\nWe will notify you when it's your turn. 🏥`;

      await WhatsAppService.sendMessage(patient.phoneNumber, message);
    } catch (error) {
      logger.error("Auto-queue: Failed to ensure patient in queue", {
        error: error instanceof Error ? error.message : error,
        doctorId,
        patientId,
      });
      // We don't throw here to avoid breaking the main visit/check-in flow
    }
  },
};
