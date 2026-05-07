import { startInsuranceClaimsCron } from "./insurance-claims.cron";
import { startInventoryExpiryCron } from "./inventory-expiry.cron";
import { startQueueScheduler } from "./queue-scheduler.cron";
import { startSmsRetryCron } from "./sms-retry.cron";

let jobsStarted: boolean | undefined;

export const startRecurringJobs = () => {
  if (jobsStarted) {
    return;
  }
  jobsStarted = true;
  startInventoryExpiryCron();
  startInsuranceClaimsCron();
  startQueueScheduler();
  startSmsRetryCron();
};
