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
    const queue = await db.queue.findUnique({
      where: { id: data.queueId },
      include: {
        entries: {
          where: { status: QueueEntryStatus.WAITING },
        },
      },
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

    // Calculate position and estimated wait time
    const position = queue.entries.length + 1;
    const estimatedWaitTime = position * queue.avgDepartmentTimeInMinutes;

    const entry = await db.queueEntry.create({
      data: {
        queueId: data.queueId,
        patientId: data.patientId,
        phoneNumber: data.phoneNumber,
        name: data.name,
        position,
        status: QueueEntryStatus.WAITING,
        source: data.source,
        joinedAt: new Date(),
        estimatedWaitTime,
        patientLat: data.patientLat,
        patientLng: data.patientLng,
        travelTimeEstimate: data.travelTimeEstimate,
        checkInTime: null, // Remote join, will check-in on arrival
        events: {
          create: {
            type: QueueEventType.JOINED,
          },
        },
      },
    });

    notifyQueueUpdate(data.queueId, { type: "NEW_ENTRY", count: position });

    return entry;
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
    } else {
      eventType = QueueEventType.SKIPPED;
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
            isTravelAlertSent: false,
            travelTimeEstimate: { not: null },
          },
          orderBy: { position: "asc" },
        },
      },
    });

    if (!queue?.queueConfig) {
      return;
    }

    const buffer = queue.queueConfig.travelTimeBuffer;

    // Check each waiting patient who hasn't been alerted yet
    for (const entry of queue.entries) {
      const waitingEntriesAhead = await db.queueEntry.count({
        where: {
          queueId,
          status: QueueEntryStatus.WAITING,
          position: { lt: entry.position },
        },
      });

      const currentWaitEstimate =
        waitingEntriesAhead * queue.avgDepartmentTimeInMinutes;
      const timeToLeaveThreshold = (entry.travelTimeEstimate || 0) + buffer;

      if (currentWaitEstimate <= timeToLeaveThreshold) {
        // It's time to notify the patient!
        await db.queueEntry.update({
          where: { id: entry.id },
          data: { isTravelAlertSent: true },
        });

        notifyEntryUpdate(entry.id, {
          type: "TRAVEL_ALERT",
          message:
            "Time to leave! Based on your travel time, you should head to the clinic now to make it for your turn.",
        });
      }
    }
  },

  getEntryStatus: async (tokenOrId: string | number) => {
    const id = Number(tokenOrId);
    return await db.queueEntry.findUnique({
      where: { id },
      include: { queue: { include: { clinic: true } } },
    });
  },
};
