import { db } from "@/database/db";
import { logger } from "@/lib/logger";
import { capabilityStatementSchema, fhirBundleSchema } from "./fhir.schemas";
import type { HieCapabilityHealth, HieHealthState } from "./health.schemas";
import { RhieRequestError, rhieRequest } from "./rhie-client";

/**
 * Probes are diagnostics, not user work: one attempt with a short timeout. The
 * default GET budget (3 attempts x 8s) meant a black-holing endpoint cost ~25s
 * per probe, which is why this used to stall the status endpoint.
 */
const PROBE_MAX_ATTEMPTS = 1;
const PROBE_TIMEOUT_MS = 3000;

/** Guards against a slow cron tick overlapping the next one. */
const MIN_RECHECK_MS = 60_000;

type TenantHealthConfig = {
  clinicId: number;
  environment: "TEST" | "PRODUCTION";
  enabled: boolean;
  clientRegistryEnabled: boolean;
  sharedRecordReadEnabled: boolean;
  sharedRecordWriteEnabled: boolean;
  transferEnabled: boolean;
  lastHealthCheckedAt: Date | null;
};

async function probeClientRegistry(
  tenantEnvironment: "TEST" | "PRODUCTION"
): Promise<void> {
  try {
    const response = await rhieRequest({
      service: "CLIENT_REGISTRY",
      method: "GET",
      path: "metadata",
      tenantEnvironment,
      maxAttempts: PROBE_MAX_ATTEMPTS,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    capabilityStatementSchema.parse(response.data);
  } catch (error) {
    // Some registry deployments gate or omit `metadata`. A 401/404 there says
    // nothing about liveness, so fall through to a real (empty) search.
    const metadataUnavailable =
      error instanceof RhieRequestError &&
      (error.status === 401 || error.status === 404);
    if (!metadataUnavailable) {
      throw error;
    }
    const response = await rhieRequest({
      service: "CLIENT_REGISTRY",
      method: "GET",
      path: "Patient",
      tenantEnvironment,
      query: { identifier: "urn:carelogic:health-check" },
      maxAttempts: PROBE_MAX_ATTEMPTS,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    fhirBundleSchema.parse(response.data);
  }
}

async function probeSharedRecord(
  tenantEnvironment: "TEST" | "PRODUCTION"
): Promise<void> {
  const response = await rhieRequest({
    service: "SHR",
    method: "GET",
    path: "metadata",
    tenantEnvironment,
    maxAttempts: PROBE_MAX_ATTEMPTS,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  capabilityStatementSchema.parse(response.data);
}

async function probeState(probe: Promise<void>): Promise<HieHealthState> {
  try {
    await probe;
    return "UP";
  } catch {
    return "DOWN";
  }
}

/**
 * Probes every capability the tenant has enabled and persists the result.
 * Capabilities the tenant does not use stay UNKNOWN rather than being reported
 * as healthy.
 */
export async function refreshTenantHealth(
  config: TenantHealthConfig
): Promise<HieCapabilityHealth | null> {
  if (!config.enabled) {
    return null;
  }
  const checkedRecently =
    config.lastHealthCheckedAt &&
    config.lastHealthCheckedAt > new Date(Date.now() - MIN_RECHECK_MS);
  if (checkedRecently) {
    return null;
  }

  const sharedRecordInUse =
    config.sharedRecordReadEnabled ||
    config.sharedRecordWriteEnabled ||
    config.transferEnabled;

  const [clientRegistry, sharedRecord] = await Promise.all([
    config.clientRegistryEnabled
      ? probeState(probeClientRegistry(config.environment))
      : Promise.resolve<HieHealthState>("UNKNOWN"),
    sharedRecordInUse
      ? probeState(probeSharedRecord(config.environment))
      : Promise.resolve<HieHealthState>("UNKNOWN"),
  ]);

  const checkedAt = new Date();
  const capabilityHealth: HieCapabilityHealth = {
    clientRegistry,
    sharedRecord,
    checkedAt: checkedAt.toISOString(),
  };

  // The scalar roll-up stays in sync so the admin connection tile and the
  // HEALTH_DEGRADED operations alert keep working off their existing field.
  const probed = [clientRegistry, sharedRecord].filter(
    (state) => state !== "UNKNOWN"
  );
  const lastHealthStatus =
    probed.length === 0 || probed.includes("DOWN") ? "DEGRADED" : "UP";

  await db.hieTenantConfig.update({
    where: { clinicId: config.clinicId },
    data: {
      capabilityHealth,
      lastHealthStatus,
      lastHealthCheckedAt: checkedAt,
    },
  });

  return capabilityHealth;
}

const inFlight = new Map<number, Promise<HieCapabilityHealth | null>>();

/**
 * Re-probes on demand, collapsing concurrent callers onto a single probe.
 *
 * The MIN_RECHECK_MS floor inside refreshTenantHealth only guards *sequential*
 * calls: it compares against the persisted lastHealthCheckedAt, which is not
 * written until the probe finishes. Without this map, several receptionists
 * opening the check-in modal at once would each start their own probe — the
 * same stampede that used to affect GET /hie/status.
 */
export function refreshTenantHealthOnDemand(
  config: TenantHealthConfig
): Promise<HieCapabilityHealth | null> {
  const existing = inFlight.get(config.clinicId);
  if (existing) {
    return existing;
  }
  const probe = refreshTenantHealth(config).finally(() => {
    inFlight.delete(config.clinicId);
  });
  inFlight.set(config.clinicId, probe);
  return probe;
}

/** Cron entry point: refreshes health for every enabled tenant. */
export async function refreshAllTenantHealth(): Promise<{ checked: number }> {
  const configs = await db.hieTenantConfig.findMany({
    where: { enabled: true },
    select: {
      clinicId: true,
      environment: true,
      enabled: true,
      clientRegistryEnabled: true,
      sharedRecordReadEnabled: true,
      sharedRecordWriteEnabled: true,
      transferEnabled: true,
      lastHealthCheckedAt: true,
    },
  });

  let checked = 0;
  for (const config of configs) {
    try {
      const health = await refreshTenantHealth(config);
      if (health) {
        checked += 1;
      }
    } catch (error) {
      // One tenant's misconfiguration must not stop the sweep.
      logger.error("hie.health.tenant_refresh_failed", {
        clinicId: config.clinicId,
        error,
      });
    }
  }
  return { checked };
}
