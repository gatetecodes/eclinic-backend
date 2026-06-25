import { CareStage, VisitStatus } from "../../generated/prisma/client";

/**
 * Maps the legal/billing `VisitStatus` to the operational `CareStage` that
 * drives the visual patient-flow pipeline.
 *
 * `status` remains the source of truth for billing, insurance claims and
 * analytics. `careStage` is an additive, operational view of "which station is
 * the patient physically at right now". A few statuses are ambiguous about the
 * station (e.g. FINALIZED can mean awaiting pharmacy OR awaiting billing); for
 * those we pick the most common default here and let explicit callers (the
 * `/advance` endpoint, pharmacy dispense flow) override with a precise stage.
 */
export const STATUS_TO_CARE_STAGE: Record<VisitStatus, CareStage> = {
  [VisitStatus.CHECKED_IN]: CareStage.RECEPTION,
  [VisitStatus.IN_PRE_CONSULTATION]: CareStage.TRIAGE,
  [VisitStatus.TRIAGE_COMPLETED]: CareStage.DOCTOR,
  [VisitStatus.IN_CONSULTATION]: CareStage.DOCTOR,
  // New flow: ordered exams must be PAID before testing, so a freshly-ordered
  // exam (PENDING_TESTS) parks the patient at the Billing(exams) gate. Once the
  // cashier settles it, /advance explicitly moves the visit to LAB.
  [VisitStatus.PENDING_TESTS]: CareStage.BILLING,
  [VisitStatus.RESULTS_READY]: CareStage.DOCTOR,
  [VisitStatus.FINALIZED]: CareStage.BILLING,
  [VisitStatus.DISCHARGED]: CareStage.DONE,
  [VisitStatus.DISCHARGED_WITH_PRESCRIPTION]: CareStage.DONE,
  [VisitStatus.ADMITTED]: CareStage.DONE,
  [VisitStatus.CANCELLED]: CareStage.DONE,
};

export const careStageForStatus = (status: VisitStatus): CareStage =>
  STATUS_TO_CARE_STAGE[status] ?? CareStage.RECEPTION;

/**
 * Ordered list of pipeline stages, left-to-right as shown in the UI.
 * DONE is terminal and usually rendered as a separate "completed" bucket.
 */
export const CARE_STAGE_ORDER: CareStage[] = [
  CareStage.RECEPTION,
  CareStage.TRIAGE,
  CareStage.DOCTOR,
  CareStage.LAB,
  CareStage.BILLING,
  CareStage.PHARMACY,
  CareStage.DONE,
];

/**
 * The `VisitStatus` to set when a patient *arrives at / is queued for* a stage
 * via the `/advance` endpoint. Note this is not the inverse of
 * STATUS_TO_CARE_STAGE (several statuses share one stage); it is the canonical
 * status for "now at this station". Callers may override (e.g. DONE can be
 * DISCHARGED_WITH_PRESCRIPTION when a prescription was issued).
 */
export const STAGE_TARGET_STATUS: Record<CareStage, VisitStatus> = {
  [CareStage.RECEPTION]: VisitStatus.CHECKED_IN,
  [CareStage.TRIAGE]: VisitStatus.IN_PRE_CONSULTATION,
  // Reaching DOCTOR via /advance only happens on the Lab → Doctor return, where
  // the doctor reviews results before finalizing — so RESULTS_READY (the
  // initial triage → doctor handoff is done by addPreConsultation, not advance).
  [CareStage.DOCTOR]: VisitStatus.RESULTS_READY,
  [CareStage.LAB]: VisitStatus.PENDING_TESTS,
  [CareStage.PHARMACY]: VisitStatus.FINALIZED,
  [CareStage.BILLING]: VisitStatus.FINALIZED,
  [CareStage.DONE]: VisitStatus.DISCHARGED,
};

/**
 * Legal stage transitions for the `/advance` endpoint, modelling the agreed
 * flow:
 *
 *   Reception → Triage → Doctor → Billing(exams) → Lab → Doctor(finalize)
 *             → Billing(final) → Pharmacy → Done
 *
 * The doctor never routes straight to Lab/Pharmacy: exams are paid at Billing
 * before testing, and meds are paid at the final Billing before dispensing.
 * Billing is the hub that fans out (Lab after exam payment; Pharmacy/Done after
 * final clearance) — see `nextStageAfterBilling`.
 */
export const ALLOWED_TRANSITIONS: Record<CareStage, CareStage[]> = {
  [CareStage.RECEPTION]: [CareStage.TRIAGE, CareStage.DONE],
  [CareStage.TRIAGE]: [CareStage.DOCTOR, CareStage.DONE],
  [CareStage.DOCTOR]: [CareStage.BILLING, CareStage.DONE],
  [CareStage.BILLING]: [
    CareStage.LAB,
    CareStage.PHARMACY,
    CareStage.DOCTOR,
    CareStage.DONE,
  ],
  [CareStage.LAB]: [CareStage.DOCTOR],
  [CareStage.PHARMACY]: [CareStage.DONE],
  [CareStage.DONE]: [],
};

export const isAllowedTransition = (from: CareStage, to: CareStage): boolean =>
  ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;

/**
 * How each stage is allowed to vary per clinic. This classification is the
 * safety boundary for admin configuration:
 *
 *  - MANDATORY  — always present; an admin can never disable these. Disabling
 *                 them would orphan the pipeline (no front door / no clinician /
 *                 no terminal state).
 *  - OPTIONAL   — the admin may turn these on or off per clinic. This is the
 *                 only knob the config UI exposes. TRIAGE is the sole member in
 *                 phase 1 (covers the "clinic has no vitals & triage" case).
 *  - CONDITIONAL— present-by-data, never by config. Whether a visit touches LAB,
 *                 BILLING or PHARMACY is decided per-visit from clinical/billing
 *                 state (see `nextStageAfterBilling` + the billing gates), NOT by
 *                 a clinic toggle. Disabling BILLING, say, would silently defeat
 *                 the pay-before-lab / pay-before-dispense gates, so it is not
 *                 disable-able.
 */
export const StageClass = {
  MANDATORY: "MANDATORY",
  OPTIONAL: "OPTIONAL",
  CONDITIONAL: "CONDITIONAL",
} as const;

export type StageClass = (typeof StageClass)[keyof typeof StageClass];

export const STAGE_CLASS: Record<CareStage, StageClass> = {
  [CareStage.RECEPTION]: StageClass.MANDATORY,
  [CareStage.TRIAGE]: StageClass.OPTIONAL,
  [CareStage.DOCTOR]: StageClass.MANDATORY,
  [CareStage.LAB]: StageClass.CONDITIONAL,
  [CareStage.BILLING]: StageClass.CONDITIONAL,
  [CareStage.PHARMACY]: StageClass.CONDITIONAL,
  [CareStage.DONE]: StageClass.MANDATORY,
};

/** Stages the admin may toggle on/off. Anything else is rejected server-side. */
export const OPTIONAL_STAGES: CareStage[] = CARE_STAGE_ORDER.filter(
  (s) => STAGE_CLASS[s] === StageClass.OPTIONAL
);

export const isOptionalStage = (stage: CareStage): boolean =>
  STAGE_CLASS[stage] === StageClass.OPTIONAL;

/**
 * Derives the left-to-right pipeline order for a clinic by removing any disabled
 * optional stages from the canonical order. Mandatory and conditional stages are
 * always retained — `disabledOptional` may only contain optional stages (the
 * caller / endpoint validation guarantees this; non-optional entries are ignored
 * defensively).
 */
export const careStageOrderFor = (
  disabledOptional: CareStage[]
): CareStage[] => {
  const disabled = new Set(
    disabledOptional.filter((s) => STAGE_CLASS[s] === StageClass.OPTIONAL)
  );
  return CARE_STAGE_ORDER.filter((s) => !disabled.has(s));
};

/**
 * Derives the legal transition graph when optional stages are disabled, by
 * "splicing out" each disabled stage: every edge that pointed *to* it is
 * rewired to its own targets, and its outgoing edges are dropped. Optional
 * stages are linear backbone stages, so this splice is well-defined (e.g.
 * removing TRIAGE rewires RECEPTION → [TRIAGE, DONE] into RECEPTION →
 * [DOCTOR, DONE]). With no stages disabled this returns the canonical graph
 * unchanged.
 */
export const allowedTransitionsFor = (
  disabledOptional: CareStage[]
): Record<CareStage, CareStage[]> => {
  const disabled = new Set(
    disabledOptional.filter((s) => STAGE_CLASS[s] === StageClass.OPTIONAL)
  );
  if (disabled.size === 0) {
    return ALLOWED_TRANSITIONS;
  }

  // Resolve a target through any chain of disabled stages to its first enabled
  // landing stage(s), guarding against revisiting a stage (no infinite loops).
  const resolveTargets = (
    targets: CareStage[],
    seen: Set<CareStage>
  ): CareStage[] => {
    const out: CareStage[] = [];
    for (const t of targets) {
      if (disabled.has(t) && !seen.has(t)) {
        out.push(
          ...resolveTargets(ALLOWED_TRANSITIONS[t] ?? [], new Set([...seen, t]))
        );
      } else if (!disabled.has(t)) {
        out.push(t);
      }
    }
    return out;
  };

  const result = {} as Record<CareStage, CareStage[]>;
  for (const stage of CARE_STAGE_ORDER) {
    if (disabled.has(stage)) {
      continue;
    }
    const rewired = resolveTargets(
      ALLOWED_TRANSITIONS[stage] ?? [],
      new Set([stage])
    );
    // De-dupe while preserving order.
    result[stage] = [...new Set(rewired)];
  }
  return result;
};

/**
 * The first stage a patient reaches after RECEPTION for a given clinic flow —
 * TRIAGE when enabled, otherwise the next enabled stage (DOCTOR). Used by the
 * reception check-in to route the new visit to the right first station.
 */
export const firstStageAfterReception = (
  disabledOptional: CareStage[]
): CareStage => {
  const order = careStageOrderFor(disabledOptional);
  const idx = order.indexOf(CareStage.RECEPTION);
  return order[idx + 1] ?? CareStage.DOCTOR;
};

/**
 * Decides where a visit goes when it leaves the Billing hub, based on its
 * status and whether a prescription was issued:
 *  - PENDING_TESTS  → exam payment just settled → LAB (run the tests)
 *  - otherwise (final clearance) → PHARMACY if a prescription exists, else DONE
 */
export const nextStageAfterBilling = (
  status: VisitStatus,
  hasPrescription: boolean
): CareStage => {
  if (status === VisitStatus.PENDING_TESTS) {
    return CareStage.LAB;
  }
  return hasPrescription ? CareStage.PHARMACY : CareStage.DONE;
};
