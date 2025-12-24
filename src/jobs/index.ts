import { startInsuranceClaimsCron } from "./insurance-claims.cron";
import { startInventoryExpiryCron } from "./inventory-expiry.cron";

let jobsStarted: boolean | undefined;

export const startRecurringJobs = () => {
  if (jobsStarted) {
    return;
  }
  jobsStarted = true;
  startInventoryExpiryCron();
  startInsuranceClaimsCron();
};
