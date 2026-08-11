import type { PlatformSetting } from "../../generated/prisma/client";
import { db } from "../database/db";

/** The single row's fixed id. There is exactly one settings record, ever. */
const SETTINGS_ID = 1;

/**
 * Read global platform settings, creating the row on first access.
 *
 * A conflict-safe insert means no caller has to handle "settings don't exist
 * yet" and concurrent first reads cannot race each other.
 */
export async function getPlatformSettings(): Promise<PlatformSetting> {
  const existing = await db.platformSetting.findUnique({
    where: { id: SETTINGS_ID },
  });
  if (existing) {
    return existing;
  }

  await db.platformSetting.createMany({
    data: { id: SETTINGS_ID },
    skipDuplicates: true,
  });
  return db.platformSetting.findUniqueOrThrow({
    where: { id: SETTINGS_ID },
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

/**
 * True when a patch carries no fields, so applying it writes nothing.
 *
 * Exported so callers that record an audit event for the update can gate on the
 * same predicate this service uses to skip the write — otherwise an empty patch
 * is logged as a settings change that never happened.
 */
export function isEmptyPlatformSettingsPatch(
  patch: PlatformSettingsPatch
): boolean {
  return Object.keys(patch).length === 0;
}

/** Apply a partial update, creating the row if it is somehow missing. */
export function updatePlatformSettings(
  patch: PlatformSettingsPatch
): Promise<PlatformSetting> {
  if (isEmptyPlatformSettingsPatch(patch)) {
    return getPlatformSettings();
  }

  return db.platformSetting.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...patch },
    update: patch,
  });
}
