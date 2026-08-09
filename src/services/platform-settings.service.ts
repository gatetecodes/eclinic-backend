import type { PlatformSetting } from "../../generated/prisma/client";
import { db } from "../database/db";

/** The single row's fixed id. There is exactly one settings record, ever. */
const SETTINGS_ID = 1;

/**
 * Read global platform settings, creating the row on first access.
 *
 * Upserting here means no caller has to handle "settings don't exist yet" — a
 * fresh database and a seeded one behave identically, and the migration's seed
 * insert is a convenience rather than a prerequisite.
 */
export function getPlatformSettings(): Promise<PlatformSetting> {
  return db.platformSetting.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID },
    update: {},
  });
}

export type PlatformSettingsPatch = Partial<
  Pick<
    PlatformSetting,
    | "requireTwoFactor"
    | "restrictAdminIps"
    | "impersonationIdleTimeoutMinutes"
    | "requireExportReason"
    | "auditRetentionDays"
  >
>;

/** Apply a partial update, creating the row if it is somehow missing. */
export function updatePlatformSettings(
  patch: PlatformSettingsPatch
): Promise<PlatformSetting> {
  return db.platformSetting.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...patch },
    update: patch,
  });
}
