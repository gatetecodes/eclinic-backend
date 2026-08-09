import cron from "node-cron";
import { logger } from "@/lib/logger";
import { processHieOutbox } from "@/services/hie/outbox.service";

export function startHieOutboxCron() {
  cron.schedule("* * * * *", async () => {
    try {
      await processHieOutbox();
    } catch (error) {
      logger.error("hie.outbox.cron_failed", { error });
    }
  });
}
