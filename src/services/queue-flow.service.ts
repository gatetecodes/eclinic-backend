import { db } from "@/database/db";
import { AppError } from "@/lib/app-error";
import { httpCodes } from "@/lib/constants";
import { notifyEntryUpdate, notifyQueueUpdate } from "@/lib/socket";
import {
  QueueEntryStatus,
  QueueEventType,
  type QueueSource,
} from "../../generated/prisma/client";

export const QueueFlowService = {
  joinQueue: async (data: {
    queueId: number;
    phoneNumber: string;
    name?: string;
    patientId?: number;
    source: QueueSource;
    patientLat?: number;
    patientLng?: number;
    travelTimeEstimate?: number;
  }) => {
    return await db.$transaction(async (tx) => {
      // 1. Lock the queue to prevent concurrent position calculations for the same queue
      await tx.$executeRaw`SELECT id FROM "Queue" WHERE id = ${data.queueId} FOR UPDATE`;

      const queue = await tx.queue.findUnique({
        where: { id: data.queueId },
      });

      if (!queue) {
        throw new AppError({
          status: httpCodes.NOT_FOUND,
          message: "Queue not found",
          code: "NOT_FOUND",
        });
      }

      if (queue.status !== "OPEN") {
        throw new AppError({
          status: httpCodes.BAD_REQUEST,
          message: "Queue is not open",
          code: "QUEUE_CLOSED",
        });
      }

      // 2. Check if already in queue (WAITING or NOTIFIED)
      const existingEntry = await tx.queueEntry.findFirst({
        where: {
          queueId: data.queueId,
          OR: [
            ...(data.patientId ? [{ patientId: data.patientId }] : []),
            { phoneNumber: data.phoneNumber },
          ],
          status: {
            in: [QueueEntryStatus.WAITING, QueueEntryStatus.NOTIFIED],
          },
        },
      });

      if (existingEntry) {
        // If the entry was joined via another source but didn't have patientId linked, link it now
        let entry = existingEntry;
        if (data.patientId && !existingEntry.patientId) {
          entry = await tx.queueEntry.update({
            where: { id: existingEntry.id },
            data: { patientId: data.patientId },
          });
        }

        const waitingAhead = await tx.queueEntry.count({
          where: {
            queueId: data.queueId,
            status: QueueEntryStatus.WAITING,
            position: { lt: entry.position },
          },
        });

        return {
          ...entry,
          waitingAhead,
          alreadyExists: true,
        };
      }

      // Calculate next position by finding the current maximum position
      const lastEntry = await tx.queueEntry.findFirst({
        where: { queueId: data.queueId },
        orderBy: { position: "desc" },
        select: { position: true },
      });

      const nextPosition = (lastEntry?.position ?? 0) + 1;

      // Count waiting entries to calculate current wait time estimate for the new entry
      const waitingCount = await tx.queueEntry.count({
        where: {
          queueId: data.queueId,
          status: QueueEntryStatus.WAITING,
        },
      });

      // Estimated wait is based on how many patients are ahead in the queue.
      // When the new entry is first in line, waitingCount will be 0 and
      // the estimated wait will correctly be 0 minutes.
      const estimatedWaitTime = waitingCount * queue.avgDepartmentTimeInMinutes;

      const entry = await tx.queueEntry.create({
        data: {
          queueId: data.queueId,
          patientId: data.patientId,
          phoneNumber: data.phoneNumber,
          name: data.name,
          position: nextPosition,
          status: QueueEntryStatus.WAITING,
          source: data.source,
          joinedAt: new Date(),
          estimatedWaitTime,
          patientLat: data.patientLat,
          patientLng: data.patientLng,
          travelTimeEstimate: data.travelTimeEstimate,
          checkInTime: null,
          events: {
            create: {
              type: QueueEventType.JOINED,
            },
          },
        },
      });

      notifyQueueUpdate(data.queueId, {
        type: "NEW_ENTRY",
        entryId: entry.id,
        count: waitingCount + 1,
        entry: {
          id: entry.id,
          position: entry.position,
          name: entry.name,
          phoneNumber: entry.phoneNumber,
          status: entry.status,
        },
      });

      return {
        ...entry,
        waitingAhead: waitingCount,
      };
    });
  },

  updateStatus: async (entryId: number, status: QueueEntryStatus) => {
    const entry = await db.queueEntry.findUnique({
      where: { id: entryId },
      include: { queue: true },
    });

    if (!entry) {
      throw new AppError({
        status: httpCodes.NOT_FOUND,
        message: "Entry not found",
        code: "NOT_FOUND",
      });
    }

    let eventType: QueueEventType;
    if (status === QueueEntryStatus.SERVED) {
      eventType = QueueEventType.SERVED;
    } else if (status === QueueEntryStatus.NOTIFIED) {
      eventType = QueueEventType.NOTIFIED;
    } else if (status === QueueEntryStatus.CANCELLED) {
      eventType = QueueEventType.CANCELLED;
    } else if (status === QueueEntryStatus.SKIPPED) {
      eventType = QueueEventType.SKIPPED;
    } else {
      throw new AppError({
        status: httpCodes.BAD_REQUEST,
        message: `Cannot update to status: ${status}`,
        code: "INVALID_STATUS_TRANSITION",
      });
    }

    const updated = await db.queueEntry.update({
      where: { id: entryId },
      data: {
        status,
        events: {
          create: {
            type: eventType,
          },
        },
        servedAt: status === QueueEntryStatus.SERVED ? new Date() : undefined,
        notifiedAt:
          status === QueueEntryStatus.NOTIFIED ? new Date() : undefined,
        cancelledAt:
          status === QueueEntryStatus.CANCELLED ? new Date() : undefined,
      },
    });

    notifyEntryUpdate(entryId, { status });
    notifyQueueUpdate(entry.queueId, {
      type: "STATUS_CHANGE",
      entryId,
      status,
    });

    // Whenever a patient is served or skipped, check if other waiting patients need to leave home
    if (
      status === QueueEntryStatus.SERVED ||
      status === QueueEntryStatus.SKIPPED
    ) {
      await QueueFlowService.checkProactiveAlerts(entry.queueId);
    }

    return updated;
  },

  checkProactiveAlerts: async (queueId: number) => {
    const queue = await db.queue.findUnique({
      where: { id: queueId },
      include: {
        queueConfig: true,
        entries: {
          where: {
            status: QueueEntryStatus.WAITING,
          },
          orderBy: { position: "asc" },
        },
      },
    });

    if (!queue?.queueConfig) {
      return;
    }

    const buffer = queue.queueConfig.travelTimeBuffer;
    const allWaitingEntries = queue.entries;

    const entriesToAlert = allWaitingEntries.filter(
      (e) => !e.isTravelAlertSent && e.travelTimeEstimate !== null
    ); // Check each waiting patient who hasn't been alerted yet
    for (const entry of entriesToAlert) {
      const waitingEntriesAhead = allWaitingEntries.filter(
        (e) => e.position < entry.position
      ).length;

      const currentWaitEstimate =
        waitingEntriesAhead * queue.avgDepartmentTimeInMinutes;
      const timeToLeaveThreshold = (entry.travelTimeEstimate || 0) + buffer;

      if (currentWaitEstimate <= timeToLeaveThreshold) {
        // It's time to notify the patient!
        // Use updateMany with isTravelAlertSent: false to ensure we only send one alert
        const updateResult = await db.queueEntry.updateMany({
          where: { id: entry.id, isTravelAlertSent: false },
          data: { isTravelAlertSent: true },
        });

        if (updateResult.count > 0) {
          notifyEntryUpdate(entry.id, {
            type: "TRAVEL_ALERT",
            message:
              "Time to leave! Based on your travel time, you should head to the clinic now to make it for your turn.",
          });
        }
      }
    }
  },

  getEntryStatus: async (tokenOrId: string | number) => {
    const id = Number(tokenOrId);
    if (Number.isNaN(id)) {
      return null;
    }
    return await db.queueEntry.findUnique({
      where: { id },
      include: { queue: { include: { clinic: true } } },
    });
  },
};
