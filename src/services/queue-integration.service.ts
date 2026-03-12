import { db } from "@/database/db";
import { DefaultDepartments } from "@/lib/constants";
import { logger } from "@/lib/logger";
import {
  QueueEntryStatus,
  QueuePurpose,
  QueueSource,
} from "../../generated/prisma/client";
import { QueueConfigService } from "./queue-config.service";
import { QueueFlowService } from "./queue-flow.service";
import { QueueManagerService } from "./queue-manager.service";
import { WhatsAppService } from "./whatsapp.service";

const sendQueueJoinedWhatsApp = async (
  phoneNumber: string,
  firstName: string | null,
  queueName: string,
  entry: {
    position: number;
    waitingAhead?: number;
    estimatedWaitTime?: number | null;
  }
) => {
  const positionInQueue = (entry.waitingAhead ?? 0) + 1;
  const waitTime = entry.estimatedWaitTime ?? 0;
  await WhatsAppService.sendTemplate({
    to: phoneNumber,
    templateName: "patient_queue_joined",
    components: [
      {
        type: "body",
        parameters: [
          { type: "text", text: firstName || "there" },
          { type: "text", text: queueName },
          { type: "text", text: entry.position.toString() },
          { type: "text", text: positionInQueue.toString() },
          { type: "text", text: waitTime.toString() },
        ],
      },
    ],
  });
};

/**
 * Ensures a cross-departmental pre-consultation QueueConfig exists and an OPEN Queue is available.
 * Creates config and opens queue on-demand when not found. One queue per branch for all departments.
 */
async function ensurePreConsultationQueueReady(
  clinicId: number,
  branchId: number
): Promise<{ id: number; name: string } | null> {
  let config = await db.queueConfig.findFirst({
    where: {
      clinicId,
      branchId,
      departmentId: null,
      purpose: QueuePurpose.PRE_CONSULTATION,
    },
  });

  if (!config) {
    config = await QueueConfigService.create({
      clinicId,
      branchId,
      name: "Pre-consultation",
      description: "Pre-consultation queue for all departments",
      departmentId: undefined,
      purpose: QueuePurpose.PRE_CONSULTATION,
    });
    logger.info("Auto-queue: Created pre-consultation config on-demand", {
      configId: config.id,
      clinicId,
      branchId,
    });
  }

  let queue = await db.queue.findFirst({
    where: {
      queueConfigId: config.id,
      status: "OPEN",
    },
    orderBy: { createdAt: "desc" },
  });

  if (!queue) {
    queue = await QueueManagerService.openQueue(config.id);
    logger.info("Auto-queue: Opened pre-consultation queue on-demand", {
      queueId: queue.id,
      configId: config.id,
    });
  }

  return { id: queue.id, name: queue.name };
}

/**
 * Ensures a lab QueueConfig exists and an OPEN Queue is available.
 */
async function ensureLabQueueReady(
  clinicId: number,
  branchId: number,
  departmentId?: number | null
): Promise<{ id: number; name: string } | null> {
  const labDept = await db.clinicalDepartment.findFirst({
    where: {
      name: DefaultDepartments.LABORATOIRE,
      clinics: { some: { id: clinicId } },
    },
    select: { id: true },
  });
  const labDeptId = labDept?.id ?? departmentId;
  if (!labDeptId) {
    return null;
  }

  let config = await db.queueConfig.findFirst({
    where: {
      clinicId,
      branchId,
      purpose: QueuePurpose.LAB,
    },
  });

  if (!config) {
    config = await QueueConfigService.create({
      clinicId,
      branchId,
      name: "Lab",
      description: "Lab sample collection queue",
      departmentId: labDeptId,
      purpose: QueuePurpose.LAB,
    });
    logger.info("Auto-queue: Created lab config on-demand", {
      configId: config.id,
      clinicId,
      branchId,
    });
  }

  let queue = await db.queue.findFirst({
    where: {
      queueConfigId: config.id,
      status: "OPEN",
    },
    orderBy: { createdAt: "desc" },
  });

  if (!queue) {
    queue = await QueueManagerService.openQueue(config.id);
    logger.info("Auto-queue: Opened lab queue on-demand", {
      queueId: queue.id,
      configId: config.id,
    });
  }

  return { id: queue.id, name: queue.name };
}

/**
 * Ensures a doctor QueueConfig exists and an OPEN Queue is available.
 */
async function ensureDoctorQueueReady(
  doctorId: number,
  clinicId: number,
  branchId: number
): Promise<{ id: number; name: string } | null> {
  let config = await db.queueConfig.findFirst({
    where: {
      clinicId,
      branchId,
      doctorId,
      purpose: QueuePurpose.DOCTOR,
    },
  });

  if (!config) {
    const doctor = await db.user.findUnique({
      where: { id: doctorId },
      select: { name: true },
    });
    const doctorName = doctor?.name ?? `Doctor ${doctorId}`;
    config = await QueueConfigService.create({
      clinicId,
      branchId,
      name: doctorName,
      description: `Consultation queue for Dr. ${doctorName}`,
      doctorId,
      purpose: QueuePurpose.DOCTOR,
    });
    logger.info("Auto-queue: Created doctor config on-demand", {
      configId: config.id,
      doctorId,
      clinicId,
      branchId,
    });
  }

  let queue = await db.queue.findFirst({
    where: {
      queueConfigId: config.id,
      status: "OPEN",
    },
    orderBy: { createdAt: "desc" },
  });

  if (!queue) {
    queue = await QueueManagerService.openQueue(config.id);
    logger.info("Auto-queue: Opened doctor queue on-demand", {
      queueId: queue.id,
      configId: config.id,
      doctorId,
    });
  }

  return { id: queue.id, name: queue.name };
}

export const QueueIntegrationService = {
  /**
   * Ensures that a patient joins a doctor's active queue if they are not already in it.
   */
  ensurePatientInDoctorQueue: async (params: {
    doctorId: number;
    patientId: number;
    clinicId: number;
    branchId: number;
    visitId?: number;
  }) => {
    const { doctorId, patientId, clinicId, branchId, visitId } = params;

    try {
      const activeQueue = await ensureDoctorQueueReady(
        doctorId,
        clinicId,
        branchId
      );

      if (!activeQueue) {
        return;
      }

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

      const displayName = [patient.firstName, patient.lastName]
        .filter(Boolean)
        .join(" ");

      const entry = await QueueFlowService.joinQueue({
        queueId: activeQueue.id,
        phoneNumber: patient.phoneNumber,
        name: displayName || undefined,
        patientId,
        visitId,
        source: QueueSource.STAFF,
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

      sendQueueJoinedWhatsApp(
        patient.phoneNumber,
        patient.firstName,
        activeQueue.name,
        entry
      ).catch((err) => {
        logger.error("Auto-queue: WhatsApp notification failed", {
          error: err instanceof Error ? err.message : String(err),
          patientId,
        });
      });
    } catch (error) {
      logger.error("Auto-queue: Failed to ensure patient in queue", {
        error: error instanceof Error ? error.message : String(error),
        doctorId,
        patientId,
      });
    }
  },

  /**
   * Ensures that a patient joins the nurse pre-consultation queue when consultation is paid.
   * Pre-consultation queues are cross-department; departmentId is not required.
   */
  ensurePatientInNursePreConsultationQueue: async (params: {
    patientId: number;
    clinicId: number;
    branchId: number;
    visitId: number;
  }) => {
    const { patientId, clinicId, branchId, visitId } = params;

    try {
      const activeQueue = await ensurePreConsultationQueueReady(
        clinicId,
        branchId
      );

      if (!activeQueue) {
        return;
      }

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

      const displayName = [patient.firstName, patient.lastName]
        .filter(Boolean)
        .join(" ");

      const entry = await QueueFlowService.joinQueue({
        queueId: activeQueue.id,
        phoneNumber: patient.phoneNumber,
        name: displayName || undefined,
        patientId,
        visitId,
        source: QueueSource.STAFF,
      });

      if ("alreadyExists" in entry && entry.alreadyExists) {
        logger.info("Auto-queue: Patient already in pre-consultation queue", {
          patientId,
          queueId: activeQueue.id,
        });
        return;
      }

      logger.info("Auto-queue: Patient joined pre-consultation queue", {
        patientId,
        queueId: activeQueue.id,
      });

      sendQueueJoinedWhatsApp(
        patient.phoneNumber,
        patient.firstName,
        activeQueue.name,
        entry
      ).catch((err) => {
        logger.error("Auto-queue: WhatsApp notification failed", {
          error: err instanceof Error ? err.message : String(err),
          patientId,
        });
      });
    } catch (error) {
      logger.error(
        "Auto-queue: Failed to ensure patient in pre-consultation queue",
        {
          error: error instanceof Error ? error.message : String(error),
          visitId,
          patientId,
        }
      );
    }
  },

  /**
   * Ensures that a patient joins the lab queue when lab exam payment is paid.
   */
  ensurePatientInLabQueue: async (params: {
    patientId: number;
    clinicId: number;
    branchId: number;
    visitId: number;
    departmentId?: number | null;
  }) => {
    const { patientId, clinicId, branchId, visitId, departmentId } = params;

    try {
      const activeQueue = await ensureLabQueueReady(
        clinicId,
        branchId,
        departmentId
      );

      if (!activeQueue) {
        logger.info(
          "Auto-queue: No lab department found, cannot create lab queue",
          {
            clinicId,
            branchId,
          }
        );
        return;
      }

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

      const displayName = [patient.firstName, patient.lastName]
        .filter(Boolean)
        .join(" ");

      const entry = await QueueFlowService.joinQueue({
        queueId: activeQueue.id,
        phoneNumber: patient.phoneNumber,
        name: displayName || undefined,
        patientId,
        visitId,
        source: QueueSource.STAFF,
      });

      if ("alreadyExists" in entry && entry.alreadyExists) {
        logger.info("Auto-queue: Patient already in lab queue", {
          patientId,
          queueId: activeQueue.id,
        });
        return;
      }

      logger.info("Auto-queue: Patient joined lab queue", {
        patientId,
        queueId: activeQueue.id,
      });

      sendQueueJoinedWhatsApp(
        patient.phoneNumber,
        patient.firstName,
        activeQueue.name,
        entry
      ).catch((err) => {
        logger.error("Auto-queue: WhatsApp notification failed", {
          error: err instanceof Error ? err.message : String(err),
          patientId,
        });
      });
    } catch (error) {
      logger.error("Auto-queue: Failed to ensure patient in lab queue", {
        error: error instanceof Error ? error.message : String(error),
        patientId,
        visitId,
      });
    }
  },

  /**
   * Marks queue entries for a visit and queue purpose as SERVED when the
   * patient is seen in that specific stage.
   */
  markQueueEntryServedForVisit: async (
    visitId: number,
    purpose: QueuePurpose
  ) => {
    try {
      const entries = await db.queueEntry.findMany({
        where: {
          visitId,
          status: { in: [QueueEntryStatus.WAITING, QueueEntryStatus.NOTIFIED] },
          queue: {
            queueConfig: {
              purpose,
            },
          },
        },
        select: { id: true },
      });

      for (const entry of entries) {
        await QueueFlowService.updateStatus(entry.id, QueueEntryStatus.SERVED);
        logger.info("Auto-queue: Marked entry as served for visit purpose", {
          visitId,
          purpose,
          entryId: entry.id,
        });
      }
    } catch (error) {
      logger.error("Auto-queue: Failed to mark entry served", {
        visitId,
        purpose,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};
