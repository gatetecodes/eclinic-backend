import cron from "node-cron";
import { logger } from "@/lib/logger";
import {
  processHieOutbox,
  recoverMissingFinalizedVisitEvents,
} from "@/services/hie/outbox.service";

export function startHieOutboxCron() {
  cron.schedule("* * * * *", async () => {
    try {
      const recovered = await recoverMissingFinalizedVisitEvents();
      if (recovered > 0) {
        logger.info("hie.outbox.finalized_visits_recovered", { recovered });
      }
    } catch (error) {
      logger.error("hie.outbox.recovery_failed", { error });
    }
    try {
      await processHieOutbox();
    } catch (error) {
      logger.error("hie.outbox.cron_failed", { error });
    }
  });
}
