import { randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";
import { practitionerLicenseStatusSchema } from "./registry.schemas";
import {
  type HieRequestEnvironment,
  isRhieServiceConfigured,
  RhieRequestError,
  rhieRequest,
} from "./rhie-client";

const LOOKUP_TIMEOUT_MS = 6000;
const LOOKUP_MAX_ATTEMPTS = 2;
const NOT_FOUND_STATUS = 404;

/**
 * License states the registry is known to report. The collection's
 * `hwms/license-status` request body carries `"CANCELLED"`; the rest are the
 * conventional siblings. Anything unrecognised is treated as not-active rather
 * than as valid — a licence we cannot classify must not grant VERIFIED.
 */
const ACTIVE_LICENSE_STATES = new Set(["ACTIVE", "VALID", "REGISTERED"]);

export type ProviderRegistryMode = "MANUAL_ONLY" | "REGISTRY";

export type PractitionerVerificationOutcome =
  | {
      status: "VERIFIED";
      practitionerId: string;
      practitionerReference: string;
      displayName: string | null;
      licenseStatus: string;
      correlationId: string;
    }
  | {
      status: "CONFLICT";
      reason:
        | "LICENSE_NOT_FOUND"
        | "LICENSE_INACTIVE"
        | "PRACTITIONER_ID_MISSING";
      licenseStatus: string | null;
      correlationId: string;
    }
  | { status: "UNAVAILABLE"; reason: "REGISTRY_NOT_CONFIGURED" };

export function providerRegistryMode(): ProviderRegistryMode {
  return isRhieServiceConfigured("PROVIDER_REGISTRY")
    ? "REGISTRY"
    : "MANUAL_ONLY";
}

/**
 * Checks a licence number against the national Provider Registry.
 *
 * Never cached. A licence that was suspended this morning must not read as
 * verified this afternoon, so this always asks upstream — unlike the facility
 * directory, these are single low-volume lookups.
 *
 * Returns `UNAVAILABLE` rather than throwing when the registry is unconfigured,
 * which is the default deployment state (MoH has not published a gateway route
 * for this registry yet). Callers surface that as "attest manually".
 */
export async function verifyPractitionerLicense(params: {
  licenseNumber: string;
  environment: HieRequestEnvironment;
  correlationId?: string;
}): Promise<PractitionerVerificationOutcome> {
  if (providerRegistryMode() === "MANUAL_ONLY") {
    return { status: "UNAVAILABLE", reason: "REGISTRY_NOT_CONFIGURED" };
  }
  const correlationId = params.correlationId ?? randomUUID();
  const licenseNumber = params.licenseNumber.trim();

  try {
    const response = await rhieRequest({
      service: "PROVIDER_REGISTRY",
      method: "GET",
      path: `Practitioner/${encodeURIComponent(licenseNumber)}/status`,
      tenantEnvironment: params.environment,
      correlationId,
      maxAttempts: LOOKUP_MAX_ATTEMPTS,
      timeoutMs: LOOKUP_TIMEOUT_MS,
    });
    const parsed = practitionerLicenseStatusSchema.parse(response.data);
    const licenseStatus = parsed.licenseStatus?.trim() ?? null;
    if (!licenseStatus) {
      return {
        status: "CONFLICT",
        reason: "LICENSE_NOT_FOUND",
        licenseStatus: null,
        correlationId,
      };
    }
    if (!ACTIVE_LICENSE_STATES.has(licenseStatus.toUpperCase())) {
      return {
        status: "CONFLICT",
        reason: "LICENSE_INACTIVE",
        licenseStatus,
        correlationId,
      };
    }
    // The registry keys practitioners by licence number, so that is the
    // Practitioner id used across the MoH payloads (see the collection's
    // `Practitioner/LIC-00785348` references).
    return {
      status: "VERIFIED",
      practitionerId: licenseNumber,
      practitionerReference: `Practitioner/${licenseNumber}`,
      displayName: null,
      licenseStatus,
      correlationId,
    };
  } catch (error) {
    if (
      error instanceof RhieRequestError &&
      error.status === NOT_FOUND_STATUS
    ) {
      return {
        status: "CONFLICT",
        reason: "LICENSE_NOT_FOUND",
        licenseStatus: null,
        correlationId,
      };
    }
    logger.warn("hie.provider_registry.lookup_failed", {
      correlationId,
      code: error instanceof RhieRequestError ? error.code : "UNKNOWN",
    });
    throw error;
  }
}
