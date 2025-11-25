import cron, { type ScheduledTask } from "node-cron";
import { logger } from "../lib/logger";
import { sendInventoryExpiryReminders } from "../services/inventory-expiry-reminder.service";

const DEFAULT_CRON = "0 6 * * *"; // 6am UTC daily
const DEFAULT_TIMEZONE = "UTC";

let inventoryExpiryTask: ScheduledTask | undefined;

const UTC_OFFSET_REGEX = /^UTC([+-])(\d{1,2})$/i;

const isTimezoneValid = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const normalizeTimezone = (input: string): string => {
  const candidate = input.trim();
  if (isTimezoneValid(candidate)) {
    return candidate;
  }

  const match = UTC_OFFSET_REGEX.exec(candidate);
  if (match) {
    const sign = match[1] === "+" ? "-" : "+";
    const hours = Number.parseInt(match[2], 10);
    const etcTz = `Etc/GMT${sign}${hours}`;
    if (isTimezoneValid(etcTz)) {
      return etcTz;
    }
  }

  logger.warn("Invalid INVENTORY_EXPIRY_CRON_TZ value, falling back to UTC", {
    candidate: input,
  });
  return DEFAULT_TIMEZONE;
};

export const startInventoryExpiryCron = () => {
  if (process.env.DISABLE_INVENTORY_EXPIRY_CRON === "true") {
    logger.info("Inventory expiry cron job disabled via env flag");
    return;
  }

  if (inventoryExpiryTask) {
    return;
  }

  const schedule = process.env.INVENTORY_EXPIRY_CRON ?? DEFAULT_CRON;
  const timezone = normalizeTimezone(
    process.env.INVENTORY_EXPIRY_CRON_TZ ?? DEFAULT_TIMEZONE
  );

  inventoryExpiryTask = cron.schedule(
    schedule,
    async () => {
      try {
        await sendInventoryExpiryReminders();
      } catch (error) {
        logger.error("Inventory expiry cron run failed", { error });
      }
    },
    {
      timezone,
    }
  );

  inventoryExpiryTask.start();

  sendInventoryExpiryReminders().catch((error) => {
    logger.error("Initial inventory expiry reminder run failed", { error });
  });

  logger.info("Inventory expiry cron scheduled", {
    schedule,
    timezone,
  });
};
