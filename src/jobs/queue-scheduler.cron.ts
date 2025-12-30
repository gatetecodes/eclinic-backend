import cron from "node-cron";
import { db } from "@/database/db";
import { logger } from "@/lib/logger";
import { QueueManagerService } from "@/services/queue-manager.service";

export const startQueueScheduler = () => {
  // Check every minute
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
  cron.schedule("* * * * *", async () => {
    try {
      const now = new Date();
      // Format current time as HH:mm
      const hours = now.getHours().toString().padStart(2, "0");
      const minutes = now.getMinutes().toString().padStart(2, "0");
      const currentTime = `${hours}:${minutes}`;

      // Find configs to open
      const configsToOpen = await db.queueConfig.findMany({
        where: {
          isAutoOpenEnabled: true,
          autoOpenTime: currentTime,
        },
      });

      for (const config of configsToOpen) {
        try {
          await QueueManagerService.openQueue(config.id);
          logger.info(`Auto-opened queue for config ${config.id}`);
        } catch (error) {
          logger.error(`Failed to auto-open queue ${config.id}`, { error });
        }
      }

      // Find queues to close (Active queues linked to config with autoCloseTime)
      // This is trickier because Queue doesn't store close time snapshot, we check config.
      // But we need to check active queues.

      const configsToClose = await db.queueConfig.findMany({
        where: {
          isAutoOpenEnabled: true,
          autoCloseTime: currentTime,
        },
      });

      for (const config of configsToClose) {
        // Find active queues for this config
        const activeQueues = await db.queue.findMany({
          where: {
            queueConfigId: config.id,
            status: "OPEN",
            closeAt: null,
          },
        });

        for (const queue of activeQueues) {
          try {
            await QueueManagerService.closeQueue(queue.id);
            logger.info(`Auto-closed queue ${queue.id}`);
          } catch (error) {
            logger.error(`Failed to auto-close queue ${queue.id}`, { error });
          }
        }
      }
    } catch (error) {
      logger.error("Queue scheduler error", { error });
    }
  });
};
