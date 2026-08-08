import cron from "node-cron";
import { db } from "@/database/db";
import { logger } from "@/lib/logger";
import { getPlatformSettings } from "@/services/platform-settings.service";

const MS_PER_DAY = 86_400_000;

/**
 * Delete operator audit events older than the configured retention window.
 *
 * Exists so the console's "events retained for N days" line is enforced rather
 * than decorative — without a prune the table grows forever and the stated policy
 * is simply untrue.
 *
 * Runs daily at 03:00 (after the nightly backup window) so a day's deletions are
 * always captured in a backup first.
 */
export const startAuditRetentionCron = () => {
  cron.schedule("0 3 * * *", async () => {
    try {
      const { auditRetentionDays } = await getPlatformSettings();
      // Guard against a misconfigured 0 wiping the whole trail.
      if (!Number.isInteger(auditRetentionDays) || auditRetentionDays < 1) {
        logger.warn("Audit retention prune skipped: invalid retention window", {
          auditRetentionDays,
        });
        return;
      }

      const cutoff = new Date(Date.now() - auditRetentionDays * MS_PER_DAY);
      const { count } = await db.adminAuditLog.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });

      if (count > 0) {
        logger.info("Pruned admin audit log", {
          deleted: count,
          cutoff,
          auditRetentionDays,
        });
      }
    } catch (error) {
      logger.error("Audit retention cron failed", { error });
    }
  });
};
