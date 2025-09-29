import type { PlanFeatureMatrix } from "../types/access";

// Initial plan-based feature matrix. This can evolve without touching route logic.
// Keep defaults conservative; we can expand as needed.
export const FEATURE_MATRIX: PlanFeatureMatrix = {
  CLINIC_STARTER: {
    visits: true,
    lab: false,
    inventory: true,
    patientPortal: false,
    analyticsPro: false,
    printPrescription: true,
    users: true,
    billing: true,
    approvals: true,
    rooms: false,
    hospitalization: false,
    insuranceClaims: false,
    notifications: false,
  },
  MEDICAL_PLUS: {
    visits: true,
    lab: true,
    inventory: true,
    patientPortal: true,
    analyticsPro: false,
    printPrescription: true,
    users: true,
    billing: true,
    approvals: true,
    rooms: true,
    hospitalization: false,
    insuranceClaims: true,
    notifications: true,
  },
  HOSPITAL_SUITE: {
    visits: true,
    lab: true,
    inventory: true,
    patientPortal: true,
    analyticsPro: true,
    printPrescription: true,
    users: true,
    billing: true,
    approvals: true,
    rooms: true,
    hospitalization: true,
    insuranceClaims: true,
    notifications: true,
  },
};

// Derivable helper types can be added later when required by API surfaces.
