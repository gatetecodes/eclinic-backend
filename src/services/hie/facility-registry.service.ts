import { randomUUID } from "node:crypto";
import { db } from "@/database/db";
import { logger } from "@/lib/logger";
import type { HieEnvironment } from "../../../generated/prisma/client";
import { fhirBundleSchema } from "./fhir.schemas";
import {
  registryLocationSchema,
  registryOrganizationSchema,
} from "./registry.schemas";
import { isRhieServiceConfigured, rhieRequest } from "./rhie-client";

const REGISTRY = "FACILITY";
const DEFAULT_PAGE_LIMIT = 500;
const MAX_PAGE_LIMIT = 1000;
const DEFAULT_MAX_PAGES = 40;
const MAX_MAX_PAGES = 200;
const DEFAULT_TTL_HOURS = 24;
const DEFAULT_MIN_SYNC_INTERVAL_MINUTES = 15;
const SYNC_TIMEOUT_MS = 20_000;
const SYNC_MAX_ATTEMPTS = 2;
const UPSERT_CHUNK_SIZE = 200;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * A FOSA code as observed in the collection: `0022`, `2601`, `0424`. Used only
 * as the last of three extraction strategies — see `extractFosaCode`.
 */
const FOSA_VALUE_PATTERN = /^\d{4,6}$/;

function clampedEnvNumber(key: string, fallback: number, max: number): number {
  const parsed = Number(process.env[key]);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) {
    return fallback;
  }
  return Math.floor(parsed);
}

function pageLimit(): number {
  return clampedEnvNumber(
    "HIE_FACILITY_DIRECTORY_PAGE_LIMIT",
    DEFAULT_PAGE_LIMIT,
    MAX_PAGE_LIMIT
  );
}

function maxPages(): number {
  return clampedEnvNumber(
    "HIE_FACILITY_DIRECTORY_MAX_PAGES",
    DEFAULT_MAX_PAGES,
    MAX_MAX_PAGES
  );
}

function ttlMs(): number {
  return (
    clampedEnvNumber(
      "HIE_FACILITY_DIRECTORY_TTL_HOURS",
      DEFAULT_TTL_HOURS,
      720
    ) * HOUR_MS
  );
}

function minSyncIntervalMs(): number {
  return (
    clampedEnvNumber(
      "HIE_FACILITY_DIRECTORY_MIN_SYNC_INTERVAL_MINUTES",
      DEFAULT_MIN_SYNC_INTERVAL_MINUTES,
      1440
    ) * MINUTE_MS
  );
}

export type FacilityDirectoryEntry = {
  fosaCode: string;
  name: string;
  locationReference: string | null;
  organizationReference: string | null;
  facilityType: string | null;
  province: string | null;
  district: string | null;
  registrySyncedAt: Date;
};

/**
 * Which mode the facility mapping screen is in.
 *
 * `MANUAL_ONLY` — no base URL configured; the console must offer manual
 * attestation only. `DIRECTORY_EMPTY` — configured but never synced, so the
 * console should offer an explicit refresh. `REGISTRY` — searchable and
 * verifiable.
 */
export type FacilityRegistryMode =
  | "MANUAL_ONLY"
  | "DIRECTORY_EMPTY"
  | "REGISTRY";

export type FacilityRegistryAvailability = {
  mode: FacilityRegistryMode;
  configured: boolean;
  entryCount: number;
  lastSyncedAt: Date | null;
  lastSyncOutcome: string | null;
  stale: boolean;
};

export type FacilityVerificationOutcome =
  | {
      status: "VERIFIED";
      entry: FacilityDirectoryEntry;
      locationReference: string;
    }
  | {
      status: "CONFLICT";
      reason:
        | "FOSA_NOT_IN_REGISTRY"
        | "LOCATION_REFERENCE_MISMATCH"
        | "LOCATION_REFERENCE_UNAVAILABLE"
        | "FACILITY_INACTIVE";
      entry: FacilityDirectoryEntry | null;
    }
  | {
      status: "UNAVAILABLE";
      reason: "REGISTRY_NOT_CONFIGURED" | "DIRECTORY_EMPTY";
    };

export function facilityRegistryConfigured(): boolean {
  return isRhieServiceConfigured("FACILITY_REGISTRY");
}

function resolveMode(
  configured: boolean,
  entryCount: number
): FacilityRegistryMode {
  if (!configured) {
    return "MANUAL_ONLY";
  }
  return entryCount > 0 ? "REGISTRY" : "DIRECTORY_EMPTY";
}

export async function facilityRegistryAvailability(
  environment: HieEnvironment
): Promise<FacilityRegistryAvailability> {
  const configured = facilityRegistryConfigured();
  const [entryCount, lastRun] = await Promise.all([
    db.hieFacilityDirectory.count({ where: { environment, active: true } }),
    db.hieRegistrySyncRun.findFirst({
      where: { registry: REGISTRY, environment },
      orderBy: { startedAt: "desc" },
      select: { outcome: true, completedAt: true, startedAt: true },
    }),
  ]);
  const lastSyncedAt = lastRun?.completedAt ?? null;
  const stale = lastSyncedAt
    ? Date.now() - lastSyncedAt.getTime() > ttlMs()
    : true;
  const mode = resolveMode(configured, entryCount);
  return {
    mode,
    configured,
    entryCount,
    lastSyncedAt,
    lastSyncOutcome: lastRun?.outcome ?? null,
    stale,
  };
}

function toEntry(row: {
  fosaCode: string;
  name: string;
  locationReference: string | null;
  organizationReference: string | null;
  facilityType: string | null;
  province: string | null;
  district: string | null;
  registrySyncedAt: Date;
}): FacilityDirectoryEntry {
  return {
    fosaCode: row.fosaCode,
    name: row.name,
    locationReference: row.locationReference,
    organizationReference: row.organizationReference,
    facilityType: row.facilityType,
    province: row.province,
    district: row.district,
    registrySyncedAt: row.registrySyncedAt,
  };
}

const ENTRY_SELECT = {
  fosaCode: true,
  name: true,
  locationReference: true,
  organizationReference: true,
  facilityType: true,
  province: true,
  district: true,
  registrySyncedAt: true,
} as const;

/**
 * Searches the snapshot. Never triggers a sync: a keystroke must not be able to
 * start a sweep of the national list.
 */
export async function searchFacilityDirectory(params: {
  environment: HieEnvironment;
  search?: string;
  district?: string;
  limit: number;
}): Promise<FacilityDirectoryEntry[]> {
  const search = params.search?.trim();
  const rows = await db.hieFacilityDirectory.findMany({
    where: {
      environment: params.environment,
      active: true,
      ...(params.district ? { district: params.district } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" as const } },
              { fosaCode: { startsWith: search } },
              { district: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: { name: "asc" },
    take: params.limit,
    select: ENTRY_SELECT,
  });
  return rows.map(toEntry);
}

/**
 * Decides whether a stored mapping matches the registry.
 *
 * A pure snapshot read — no network. That is deliberate: verification keeps
 * working while the gateway is down, which is exactly when an admin is most
 * likely to be trying to finish setup.
 */
export async function verifyFacilityIdentity(params: {
  environment: HieEnvironment;
  fosaCode: string;
  locationReference: string;
}): Promise<FacilityVerificationOutcome> {
  if (!facilityRegistryConfigured()) {
    return { status: "UNAVAILABLE", reason: "REGISTRY_NOT_CONFIGURED" };
  }
  const row = await db.hieFacilityDirectory.findUnique({
    where: {
      environment_fosaCode: {
        environment: params.environment,
        fosaCode: params.fosaCode.trim(),
      },
    },
    select: { ...ENTRY_SELECT, active: true },
  });
  if (!row) {
    const populated = await db.hieFacilityDirectory.count({
      where: { environment: params.environment },
    });
    if (populated === 0) {
      return { status: "UNAVAILABLE", reason: "DIRECTORY_EMPTY" };
    }
    return { status: "CONFLICT", reason: "FOSA_NOT_IN_REGISTRY", entry: null };
  }
  const entry = toEntry(row);
  if (!row.active) {
    return { status: "CONFLICT", reason: "FACILITY_INACTIVE", entry };
  }
  if (!entry.locationReference) {
    return {
      status: "CONFLICT",
      reason: "LOCATION_REFERENCE_UNAVAILABLE",
      entry,
    };
  }
  if (entry.locationReference !== params.locationReference.trim()) {
    return {
      status: "CONFLICT",
      reason: "LOCATION_REFERENCE_MISMATCH",
      entry,
    };
  }
  return {
    status: "VERIFIED",
    entry,
    locationReference: entry.locationReference,
  };
}

/**
 * Reads the FOSA code out of a registry resource's identifiers.
 *
 * Three strategies in order of trustworthiness, because MoH has not yet told us
 * which `identifier.system` carries the code:
 *   1. the system pinned in HIE_FACILITY_REGISTRY_FOSA_SYSTEM (once known);
 *   2. any system whose name mentions "fosa";
 *   3. any value shaped like a FOSA code.
 * A resource none of these match is skipped and counted — never guessed at.
 */
function extractFosaCode(
  identifiers: readonly { system?: string; value?: string }[]
): { fosaCode: string; identifierSystem: string | null } | null {
  const withValue = identifiers.filter(
    (identifier): identifier is { system?: string; value: string } =>
      typeof identifier.value === "string" && identifier.value.trim().length > 0
  );
  const pinned = process.env.HIE_FACILITY_REGISTRY_FOSA_SYSTEM?.trim();
  const match =
    (pinned
      ? withValue.find((identifier) => identifier.system === pinned)
      : undefined) ??
    withValue.find((identifier) =>
      identifier.system?.toLowerCase().includes("fosa")
    ) ??
    withValue.find((identifier) =>
      FOSA_VALUE_PATTERN.test(identifier.value.trim())
    );
  if (!match) {
    return null;
  }
  return {
    fosaCode: match.value.trim(),
    identifierSystem: match.system ?? null,
  };
}

type MappedFacility = {
  fosaCode: string;
  resourceType: string;
  resourceId: string;
  locationReference: string | null;
  organizationReference: string | null;
  name: string;
  facilityType: string | null;
  province: string | null;
  district: string | null;
  identifierSystem: string | null;
};

/**
 * Maps one registry resource onto a directory row, or returns null when the
 * resource cannot be used.
 *
 * The single place that knows the registry's shape, so one clarification from
 * MoH is a one-function change.
 */
export function mapRegistryLocation(resource: unknown): MappedFacility | null {
  const asLocation = registryLocationSchema.safeParse(resource);
  const asOrganization = asLocation.success
    ? null
    : registryOrganizationSchema.safeParse(resource);
  if (!(asLocation.success || asOrganization?.success)) {
    return null;
  }

  // A Location carries `address` as a single object in the observed payloads,
  // an Organization as a list. Normalise to one shape before reading it.
  const value: {
    id?: string;
    name?: string;
    identifier?: readonly { system?: string; value?: string }[];
    type?: readonly {
      text?: string;
      coding?: readonly { display?: string }[];
    }[];
    address?: { state?: string; district?: string };
  } = asLocation.success
    ? asLocation.data
    : {
        ...asOrganization?.data,
        address: asOrganization?.data.address?.[0],
      };

  const resourceId = value.id?.trim();
  const name = value.name?.trim();
  const fosa = extractFosaCode(value.identifier ?? []);
  if (!(resourceId && name && fosa)) {
    return null;
  }

  const isLocation = asLocation.success;
  const facilityType =
    value.type?.[0]?.text?.trim() ??
    value.type?.[0]?.coding?.[0]?.display?.trim() ??
    null;
  return {
    fosaCode: fosa.fosaCode,
    resourceType: isLocation ? "Location" : "Organization",
    resourceId,
    // Only a Location yields a reference our mappings can store.
    locationReference: isLocation ? `Location/${resourceId}` : null,
    organizationReference: isLocation ? null : `Organization/${resourceId}`,
    name,
    facilityType,
    province: value.address?.state?.trim() ?? null,
    district: value.address?.district?.trim() ?? null,
    identifierSystem: fosa.identifierSystem,
  };
}

type FetchResult = {
  facilities: MappedFacility[];
  skipped: number;
  pages: number;
  observedSystems: Set<string>;
};

/**
 * Walks the registry's pages, mapping as it goes. Writes nothing.
 *
 * Stops on: an empty page, a short page (the last one), a page longer than the
 * requested limit (the gateway ignored paging, so this response *is* the whole
 * list), a repeated first resource id (same conclusion, non-empty), or the hard
 * page cap.
 */
type RegistryPage = {
  entries: readonly { resource: Record<string, unknown> }[];
  firstResourceId: string | null;
};

async function fetchPage(params: {
  environment: HieEnvironment;
  correlationId: string;
  page: number;
  limit: number;
}): Promise<RegistryPage> {
  const response = await rhieRequest({
    service: "FACILITY_REGISTRY",
    method: "GET",
    path: "fhir",
    tenantEnvironment: params.environment,
    query: { page: String(params.page), limit: String(params.limit) },
    correlationId: params.correlationId,
    maxAttempts: SYNC_MAX_ATTEMPTS,
    timeoutMs: SYNC_TIMEOUT_MS,
  });
  const bundle = fhirBundleSchema.parse(response.data);
  const entries = bundle.entry ?? [];
  const firstResource = entries[0]?.resource;
  return {
    entries,
    firstResourceId:
      typeof firstResource?.id === "string" ? firstResource.id : null,
  };
}

/** Accumulates one page into the result, counting unusable entries. */
function collectPage(
  page: RegistryPage,
  into: { facilities: MappedFacility[]; observedSystems: Set<string> }
): number {
  let skipped = 0;
  for (const entry of page.entries) {
    const mapped = mapRegistryLocation(entry.resource);
    if (!mapped) {
      skipped += 1;
      continue;
    }
    into.facilities.push(mapped);
    if (mapped.identifierSystem) {
      into.observedSystems.add(mapped.identifierSystem);
    }
  }
  return skipped;
}

/**
 * True when this page is the last one worth asking for.
 *
 * A page that is shorter than the limit is simply the end. A page *longer* than
 * the limit means the gateway ignored `limit` — in which case this single
 * response already is the whole national list, so asking for page 2 would only
 * fetch the same rows again.
 */
function isFinalPage(entryCount: number, limit: number): boolean {
  return entryCount !== limit;
}

async function fetchAllPages(
  environment: HieEnvironment,
  correlationId: string
): Promise<FetchResult> {
  const limit = pageLimit();
  const cap = maxPages();
  const accumulator = {
    facilities: [] as MappedFacility[],
    observedSystems: new Set<string>(),
  };
  let skipped = 0;
  let pages = 0;
  let previousFirstId: string | null = null;

  for (let page = 1; page <= cap; page += 1) {
    const fetched = await fetchPage({
      environment,
      correlationId,
      page,
      limit,
    });
    pages = page;
    if (fetched.entries.length === 0) {
      break;
    }
    // Paging ignored: the same rows came back, so we already hold them.
    if (
      fetched.firstResourceId !== null &&
      fetched.firstResourceId === previousFirstId
    ) {
      break;
    }
    previousFirstId = fetched.firstResourceId;
    skipped += collectPage(fetched, accumulator);
    if (isFinalPage(fetched.entries.length, limit)) {
      break;
    }
  }

  return {
    facilities: accumulator.facilities,
    skipped,
    pages,
    observedSystems: accumulator.observedSystems,
  };
}

/** First occurrence of each FOSA code wins; the rest count as skipped. */
function dedupeByFosaCode(facilities: MappedFacility[]): {
  unique: MappedFacility[];
  duplicates: number;
} {
  const seen = new Set<string>();
  const unique: MappedFacility[] = [];
  let duplicates = 0;
  for (const facility of facilities) {
    if (seen.has(facility.fosaCode)) {
      duplicates += 1;
      continue;
    }
    seen.add(facility.fosaCode);
    unique.push(facility);
  }
  return { unique, duplicates };
}

export type FacilitySyncResult = {
  skipped: boolean;
  reason?: "NOT_CONFIGURED" | "RECENTLY_SYNCED";
  entryCount: number;
  skippedCount: number;
  pageCount: number;
  lastSyncedAt: Date | null;
  correlationId: string;
};

const inFlight = new Map<string, Promise<FacilitySyncResult>>();

/**
 * Refreshes the snapshot.
 *
 * Fetches every page *before* writing anything, then swaps the directory in one
 * transaction. A gateway failure mid-sweep therefore leaves the existing
 * directory byte-identical, so the picker and verification keep working.
 * Facilities absent from a completed sweep are deactivated, never deleted — a
 * mapping verified against a row the registry later dropped must stay auditable.
 */
export function syncFacilityDirectory(params: {
  environment: HieEnvironment;
  correlationId?: string;
  force?: boolean;
}): Promise<FacilitySyncResult> {
  const key = params.environment;
  const existing = inFlight.get(key);
  if (existing) {
    // Collapse concurrent callers onto one sweep — the cron and an admin's
    // manual refresh must not both walk the national list.
    return existing;
  }
  const run = performSync(params).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, run);
  return run;
}

async function performSync(params: {
  environment: HieEnvironment;
  correlationId?: string;
  force?: boolean;
}): Promise<FacilitySyncResult> {
  const correlationId = params.correlationId ?? randomUUID();
  const { environment } = params;
  if (!facilityRegistryConfigured()) {
    return {
      skipped: true,
      reason: "NOT_CONFIGURED",
      entryCount: 0,
      skippedCount: 0,
      pageCount: 0,
      lastSyncedAt: null,
      correlationId,
    };
  }

  const lastSuccess = await db.hieRegistrySyncRun.findFirst({
    where: { registry: REGISTRY, environment, outcome: "SUCCEEDED" },
    orderBy: { startedAt: "desc" },
    select: { completedAt: true },
  });
  if (
    !params.force &&
    lastSuccess?.completedAt &&
    Date.now() - lastSuccess.completedAt.getTime() < minSyncIntervalMs()
  ) {
    return {
      skipped: true,
      reason: "RECENTLY_SYNCED",
      entryCount: 0,
      skippedCount: 0,
      pageCount: 0,
      lastSyncedAt: lastSuccess.completedAt,
      correlationId,
    };
  }

  const runRow = await db.hieRegistrySyncRun.create({
    data: {
      registry: REGISTRY,
      environment,
      outcome: "RUNNING",
      correlationId,
    },
    select: { id: true },
  });

  try {
    const fetched = await fetchAllPages(environment, correlationId);
    const { unique, duplicates } = dedupeByFosaCode(fetched.facilities);
    if (unique.length === 0) {
      throw new Error("Facility registry returned no usable entries");
    }
    const syncedAt = new Date();

    await db.$transaction(async (tx) => {
      for (let index = 0; index < unique.length; index += UPSERT_CHUNK_SIZE) {
        const chunk = unique.slice(index, index + UPSERT_CHUNK_SIZE);
        await Promise.all(
          chunk.map((facility) =>
            tx.hieFacilityDirectory.upsert({
              where: {
                environment_resourceType_resourceId: {
                  environment,
                  resourceType: facility.resourceType,
                  resourceId: facility.resourceId,
                },
              },
              create: {
                environment,
                registrySyncedAt: syncedAt,
                active: true,
                ...facility,
              },
              update: {
                registrySyncedAt: syncedAt,
                active: true,
                ...facility,
              },
            })
          )
        );
      }
      await tx.hieFacilityDirectory.updateMany({
        where: {
          environment,
          active: true,
          registrySyncedAt: { lt: syncedAt },
        },
        data: { active: false },
      });
    });

    const skippedCount = fetched.skipped + duplicates;
    await db.hieRegistrySyncRun.update({
      where: { id: runRow.id },
      data: {
        outcome: "SUCCEEDED",
        completedAt: syncedAt,
        entryCount: unique.length,
        skippedCount,
        pageCount: fetched.pages,
      },
    });
    // Facility identifier systems are not PHI. This log is the evidence used to
    // pin HIE_FACILITY_REGISTRY_FOSA_SYSTEM with MoH.
    logger.info("hie.facility_directory.synced", {
      environment,
      entryCount: unique.length,
      skippedCount,
      pageCount: fetched.pages,
      observedIdentifierSystems: [...fetched.observedSystems],
      correlationId,
    });
    return {
      skipped: false,
      entryCount: unique.length,
      skippedCount,
      pageCount: fetched.pages,
      lastSyncedAt: syncedAt,
      correlationId,
    };
  } catch (error) {
    const errorCode =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "SYNC_FAILED";
    await db.hieRegistrySyncRun.update({
      where: { id: runRow.id },
      data: { outcome: "FAILED", completedAt: new Date(), errorCode },
    });
    throw error;
  }
}

/**
 * Runs a sync only when it is due, so the cron makes zero network calls on a
 * deployment that has no registry configured.
 */
export function syncFacilityDirectoryIfDue(
  environment: HieEnvironment
): Promise<FacilitySyncResult> {
  return syncFacilityDirectory({ environment });
}
