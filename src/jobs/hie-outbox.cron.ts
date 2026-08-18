import cron from "node-cron";
import { logger } from "@/lib/logger";
import { syncFacilityDirectoryIfDue } from "@/services/hie/facility-registry.service";
import { refreshAllTenantHealth } from "@/services/hie/health.service";
import { monitorHieOperations } from "@/services/hie/operations-metrics.service";
import {
  processHieOutbox,
  recoverMissingFinalizedVisitEvents,
} from "@/services/hie/outbox.service";
import { processPendingIdentityVerifications } from "@/services/hie/pending-identity.service";

/**
 * Probes health once at boot. node-cron only fires on wall-clock boundaries, so
 * without this every tenant reads UNKNOWN — and reception sees the national
 * lookup as if the service were live — until the first five-minute tick.
 * Deliberately not awaited: startup must not block on an unreachable service.
 */
function probeHealthOnStartup() {
  refreshAllTenantHealth()
    .then((health) => {
      if (health.checked > 0) {
        logger.info("hie.health.startup_refresh_completed", health);
      }
    })
    .catch((error) => {
      logger.error("hie.health.startup_refresh_failed", { error });
    });
}

/**
 * Both schedules reach the national services, so a tick can outlive its own
 * interval when RHIE is slow. `noOverlap` drops the next tick instead of
 * stacking it, which is what let concurrent probes pile up before health moved
 * off the request path.
 */
const HIE_TASK_OPTIONS = { noOverlap: true } as const;

/**
 * The directory is national reference data with no tenant, so the sweep runs
 * against the deployment's own environment. `rhieRequest` then asserts that this
 * matches the endpoint and credential environments, as it does for every call.
 */
function deploymentHieEnvironment(): "TEST" | "PRODUCTION" {
  return process.env.HIE_DEPLOYMENT_ENVIRONMENT === "PRODUCTION"
    ? "PRODUCTION"
    : "TEST";
}

export function startHieOutboxCron() {
  probeHealthOnStartup();
  cron.schedule(
    "* * * * *",
    async () => {
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
    },
    HIE_TASK_OPTIONS
  );
  // Nightly, and only when a registry is configured and the snapshot is due —
  // an unconfigured deployment makes zero network calls. Deliberately not on the
  // five-minute tick: this endpoint returns the whole national facility list.
  cron.schedule(
    "15 3 * * *",
    async () => {
      try {
        const result = await syncFacilityDirectoryIfDue(
          deploymentHieEnvironment()
        );
        if (!result.skipped) {
          logger.info("hie.facility_directory.sync_completed", result);
        }
      } catch (error) {
        logger.error("hie.facility_directory.sync_failed", { error });
      }
    },
    HIE_TASK_OPTIONS
  );
  cron.schedule(
    "*/5 * * * *",
    async () => {
      // Health probing lives here rather than on GET /hie/status so an
      // unreachable national service never delays a user-facing request.
      try {
        const health = await refreshAllTenantHealth();
        if (health.checked > 0) {
          logger.info("hie.health.refresh_completed", health);
        }
      } catch (error) {
        logger.error("hie.health.refresh_failed", { error });
      }
      try {
        await monitorHieOperations();
      } catch (error) {
        logger.error("hie.operations.monitor_failed", { error });
      }
    },
    HIE_TASK_OPTIONS
  );
}
