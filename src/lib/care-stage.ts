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
  CareStage.PHARMACY,
  CareStage.BILLING,
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
