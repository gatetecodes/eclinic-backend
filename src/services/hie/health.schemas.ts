import { z } from "zod";

/**
 * Liveness of a single national service, kept separate from whether the tenant
 * has the capability switched on. A capability can be enabled and DOWN, and
 * that distinction is the whole point of this module — reception needs to know
 * the Client Registry specifically is unreachable, not that "HIE is degraded".
 *
 * Pure parsing lives here, apart from the probing service, so reading health
 * does not drag in the database or the RHIE client.
 */
export type HieHealthState = "UP" | "DOWN" | "UNKNOWN";

const HEALTH_STATE = ["UP", "DOWN", "UNKNOWN"] as const;

export const capabilityHealthSchema = z.object({
  clientRegistry: z.enum(HEALTH_STATE),
  sharedRecord: z.enum(HEALTH_STATE),
  checkedAt: z.iso.datetime(),
});

export type HieCapabilityHealth = z.infer<typeof capabilityHealthSchema>;

type StoredHealthConfig = {
  capabilityHealth: unknown;
  lastHealthCheckedAt: Date | null;
};

const UNKNOWN_HEALTH: HieCapabilityHealth = {
  clientRegistry: "UNKNOWN",
  sharedRecord: "UNKNOWN",
  checkedAt: new Date(0).toISOString(),
};

/**
 * Reads the persisted per-capability health. Anything absent or malformed
 * degrades to UNKNOWN rather than throwing — an unreadable health record must
 * never take down the status endpoint that reports it, and UNKNOWN is
 * deliberately not DOWN so it cannot gate a working registry off.
 */
export function readCapabilityHealth(
  config: StoredHealthConfig
): HieCapabilityHealth | null {
  if (config.capabilityHealth === null) {
    return null;
  }
  const parsed = capabilityHealthSchema.safeParse(config.capabilityHealth);
  if (!parsed.success) {
    return {
      ...UNKNOWN_HEALTH,
      checkedAt: (config.lastHealthCheckedAt ?? new Date(0)).toISOString(),
    };
  }
  return parsed.data;
}
