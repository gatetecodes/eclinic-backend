import type { CareStage } from "../../generated/prisma/client";
import { db } from "../database/db";
import { getCachedData, invalidateCache } from "../services/redis.service";
import {
  ALLOWED_TRANSITIONS,
  allowedTransitionsFor,
  CARE_STAGE_ORDER,
  careStageOrderFor,
  firstStageAfterReception,
  isOptionalStage,
} from "./care-stage";

/**
 * Resolved, clinic-specific view of the care flow. `disabledOptional` is the
 * persisted truth (which optional stages this clinic turned off); everything
 * else is derived from it by the pure helpers in `care-stage.ts`, so callers get
 * a ready-to-use order + transition graph without re-deriving.
 */
export type ResolvedFlow = {
  /** Optional stages this clinic has disabled (e.g. `[TRIAGE]`). */
  disabledOptional: CareStage[];
  /** Left-to-right pipeline order with disabled stages removed. */
  order: CareStage[];
  /** Legal `/advance` transitions for this clinic. */
  transitions: Record<CareStage, CareStage[]>;
  /** First station after RECEPTION (TRIAGE when enabled, else DOCTOR). */
  firstAfterReception: CareStage;
};

const FLOW_CONFIG_CACHE_KEY = "flow-config";
const FLOW_CONFIG_TTL_SECONDS = 60 * 30; // 30 min; invalidated on config save.

const cacheKey = (clinicId: number, branchId?: number | null) =>
  `${FLOW_CONFIG_CACHE_KEY}:${clinicId}:${branchId ?? "ALL"}`;

const buildResolved = (disabledOptional: CareStage[]): ResolvedFlow => ({
  disabledOptional,
  order: careStageOrderFor(disabledOptional),
  transitions: allowedTransitionsFor(disabledOptional),
  firstAfterReception: firstStageAfterReception(disabledOptional),
});

/**
 * Computes the set of disabled optional stages for a clinic/branch from the
 * `ClinicFlowConfig` rows. Branch-specific rows override the clinic-wide
 * (`branchId = null`) defaults per stage. Only OPTIONAL stages can be disabled;
 * any `enabled = false` row for a mandatory/conditional stage is ignored so a
 * bad row can never break the pipeline.
 */
const computeDisabledOptional = async (
  clinicId: number,
  branchId?: number | null
): Promise<CareStage[]> => {
  const rows = await db.clinicFlowConfig.findMany({
    where: {
      clinicId,
      OR: [{ branchId: null }, ...(branchId ? [{ branchId }] : [])],
    },
    select: { stage: true, branchId: true, enabled: true },
  });

  // Effective enabled-state per stage: branch row (branchId set) wins over the
  // clinic default (branchId null).
  const effective = new Map<CareStage, boolean>();
  for (const r of rows.filter((row) => row.branchId === null)) {
    effective.set(r.stage, r.enabled);
  }
  if (branchId) {
    for (const r of rows.filter((row) => row.branchId === branchId)) {
      effective.set(r.stage, r.enabled);
    }
  }

  return CARE_STAGE_ORDER.filter(
    (stage) => isOptionalStage(stage) && effective.get(stage) === false
  );
};

/**
 * Resolves the active care flow for a clinic/branch, cached. When no config rows
 * exist yet (e.g. a clinic created before the config feature shipped, or before
 * its defaults are seeded) it falls back to the canonical all-stages-enabled
 * flow — identical to the legacy hardcoded behaviour.
 */
export const resolveClinicFlow = async (
  clinicId: number,
  branchId?: number | null
): Promise<ResolvedFlow> => {
  const disabledOptional = await getCachedData(
    cacheKey(clinicId, branchId),
    () => computeDisabledOptional(clinicId, branchId),
    FLOW_CONFIG_TTL_SECONDS
  );
  return buildResolved(disabledOptional);
};

/**
 * Default `ClinicFlowConfig` rows for a freshly-created clinic: every stage
 * enabled, in canonical order, as a clinic-wide (`branchId = null`) default.
 * Returned as plain data so the caller can insert them inside its own
 * transaction (e.g. clinic creation). Matches the seed in the migration.
 */
export const defaultFlowConfigRows = (clinicId: number) =>
  CARE_STAGE_ORDER.map((stage, position) => ({
    clinicId,
    branchId: null,
    stage,
    position,
    enabled: true,
  }));

/** The canonical, all-stages-enabled flow (no clinic config consulted). */
export const canonicalFlow = (): ResolvedFlow => ({
  disabledOptional: [],
  order: CARE_STAGE_ORDER,
  transitions: ALLOWED_TRANSITIONS,
  firstAfterReception: firstStageAfterReception([]),
});

/**
 * Drops the cached flow config for a clinic (all branches). Call after any
 * `ClinicFlowConfig` write so the next resolve reflects the change immediately.
 */
export const invalidateClinicFlowCache = (clinicId: number): Promise<void> =>
  invalidateCache(`${FLOW_CONFIG_CACHE_KEY}:${clinicId}:*`);
