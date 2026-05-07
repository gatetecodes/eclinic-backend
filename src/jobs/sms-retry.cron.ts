import cron from "node-cron";
import { logger } from "@/lib/logger";
import { SmsService } from "@/services/sms.service";

export const startSmsRetryCron = () => {
  cron.schedule("* * * * *", async () => {
    // every minute
    try {
      await SmsService.retryFailedMessages();
    } catch (error) {
      logger.error("SMS retry cron failed", { error });
    }
  });
};
