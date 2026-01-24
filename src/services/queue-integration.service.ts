import { db } from "@/database/db";
import { logger } from "@/lib/logger";
import { QueueSource } from "../../generated/prisma/client";
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

      // 3. Join the queue (thread-safe and idempotent)
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

      if ("alreadyExists" in entry && entry.alreadyExists) {
        logger.info("Auto-queue: Patient already in queue", {
          patientId,
          queueId: activeQueue.id,
          entryId: entry.id,
        });
        return;
      }

      logger.info("Auto-queue: Patient joined queue successfully", {
        patientId,
        queueId: activeQueue.id,
      });

      // 4. Notify the patient via Template (required for unprompted messages)
      const positionInQueue = (entry.waitingAhead ?? 0) + 1;
      const waitTime = entry.estimatedWaitTime ?? 0;

      await WhatsAppService.sendTemplate({
        to: patient.phoneNumber,
        templateName: "patient_queue_joined", // Template must be created in Meta Business Suite
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: patient.firstName || "there" },
              { type: "text", text: activeQueue.name },
              { type: "text", text: entry.position.toString() },
              { type: "text", text: positionInQueue.toString() },
              { type: "text", text: waitTime.toString() },
            ],
          },
        ],
      });
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
