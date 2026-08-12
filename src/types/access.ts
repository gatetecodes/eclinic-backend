import type { SubscriptionPlan } from "../../generated/prisma/client";

// Resources reflect backend API domains under src/api/v1/*
export type Resource =
  | "activity"
  | "admin"
  | "analytics"
  | "appointments"
  | "approvals"
  | "clinics"
  | "departments"
  | "exams"
  | "prescription"
  | "files"
  | "insurance"
  | "insuranceClaims"
  | "inventory"
  | "notifications"
  | "patients"
  | "payments"
  | "tariff"
  | "users"
  | "visits"
  | "performanceReports"
  | "pharmacy"
  | "hie";

// Actions are coarse-grained verbs aligned with controller operations
export type Action =
  | "create"
  | "read"
  | "update"
  | "delete"
  | "approve"
  | "process"
  | "readVisitDetails"
  | "printPrescription"
  | "viewPerformanceReports"
  | "readMyProfile"
  | "addPaymentMethod"
  | "dischargePatient"
  | "addExams"
  | "updatePreConsultation"
  | "updateInitialCheckin"
  | "dispense"
  | "manageHieConsent"
  | "viewHieTransfers"
  | "manageHieTransfers"
  | "emergencyHieRead"
  | "reviewEmergencyHieAccess"
  | "manageHieAllergies"
  | "manageHieImmunizations"
  | "manageHieImaging";

// Feature flags represent product-surface capabilities that can be plan/tier gated
export type FeatureKey =
  | "visits"
  | "lab"
  | "inventory"
  | "patientPortal"
  | "analyticsPro"
  | "printPrescription"
  | "users"
  | "billing"
  | "approvals"
  | "rooms"
  | "hospitalization"
  | "notifications"
  | "insuranceClaims"
  | "pharmacy"
  | "hie";

export type EntitlementStatus = "ACTIVE" | "TRIAL" | "INACTIVE" | "EXPIRED";

export type Entitlements = {
  features: Record<FeatureKey, boolean>;
  status: EntitlementStatus;
  limits?: Record<FeatureKey, number | undefined>;
};

// Helper shape describing plan-based feature matrix entries
export type PlanFeatureMatrix = Record<
  SubscriptionPlan,
  Record<FeatureKey, boolean>
>;
