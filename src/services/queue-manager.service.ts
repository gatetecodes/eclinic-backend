import { db } from "@/database/db";
import { AppError } from "@/lib/app-error";
import { httpCodes } from "@/lib/constants";
import { notifyQueueUpdate } from "@/lib/socket";
import { QueueStatus } from "../../generated/prisma/client";

export const QueueManagerService = {
  openQueue: async (configId: number) => {
    const config = await db.queueConfig.findUnique({ where: { id: configId } });
    if (!config) {
      throw new AppError({
        status: httpCodes.NOT_FOUND,
        message: "Config not found",
        code: "NOT_FOUND",
      });
    }

    // Check if already open
    const existing = await db.queue.findFirst({
      where: {
        queueConfigId: configId,
        status: { in: [QueueStatus.OPEN, QueueStatus.PAUSED] },
        closeAt: null,
      },
    });

    if (existing) {
      return existing; // Return existing session
    }

    const queue = await db.queue.create({
      data: {
        queueConfigId: configId,
        clinicId: config.clinicId,
        branchId: config.branchId,
        departmentId: config.departmentId,
        doctorId: config.doctorId,
        name: config.name,
        avgDepartmentTimeInMinutes: config.defaultAvgTime,
        status: QueueStatus.OPEN,
        startAt: new Date(),
      },
    });

    notifyQueueUpdate(queue.id, { status: "OPEN" });
    return queue;
  },

  closeQueue: async (queueId: number) => {
    const queue = await db.queue.update({
      where: { id: queueId },
      data: {
        status: QueueStatus.CLOSED,
        closeAt: new Date(),
      },
    });

    notifyQueueUpdate(queue.id, { status: "CLOSED" });
    return queue;
  },

  listActiveQueues: async (clinicId: number, doctorId?: number) => {
    const queues = await db.queue.findMany({
      where: {
        clinicId,
        status: { not: QueueStatus.CLOSED },
        doctorId: doctorId !== undefined ? doctorId : undefined,
      },
      include: {
        queueConfig: true,
        entries: {
          where: { status: "WAITING" }, // Only count waiting
        },
      },
    });

    return queues;
  },
};
