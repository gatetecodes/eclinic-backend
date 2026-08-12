import cron from "node-cron";
import { logger } from "@/lib/logger";
import { monitorHieOperations } from "@/services/hie/operations-metrics.service";
import {
  processHieOutbox,
  recoverMissingFinalizedVisitEvents,
} from "@/services/hie/outbox.service";
import { processPendingIdentityVerifications } from "@/services/hie/pending-identity.service";

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
      const identities = await processPendingIdentityVerifications();
      if (identities.processed > 0) {
        logger.info("hie.identity.retry_cycle_completed", identities);
      }
    } catch (error) {
      logger.error("hie.identity.retry_cycle_failed", { error });
    }
    try {
      await processHieOutbox();
    } catch (error) {
      logger.error("hie.outbox.cron_failed", { error });
    }
  });
  cron.schedule("*/5 * * * *", async () => {
    try {
      await monitorHieOperations();
    } catch (error) {
      logger.error("hie.operations.monitor_failed", { error });
    }
  });
}
