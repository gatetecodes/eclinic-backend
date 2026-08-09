import type { Role } from "../../generated/prisma/client";
import type { Action, Resource } from "../types/access";

export type PermissionConfig = Partial<
  Record<Resource, Partial<Record<Action, boolean>>>
>;

export const ROLE_PERMISSIONS: Record<Role, PermissionConfig> = {
  SUPER_ADMIN: {
    // SUPER_ADMIN has implicit allow via hasPermission, so this entry is not what
    // grants access. It is declared anyway so the matrix documents the
    // platform-operator surface (see src/api/v1/admin) and so `admin` is not a
    // Resource that appears nowhere. Enforcement is the `requireSuperAdmin`
    // middleware; no other role is granted `admin` below.
    admin: { read: true, create: true, update: true, delete: true },
  },
  CLINIC_ADMIN: {
    // Clinic-level configuration (e.g. care-flow stage config). Scoped to the
    // admin's own clinic by the controllers, not arbitrary clinics.
    clinics: { read: true, update: true },
    exams: { read: true, create: true, update: true },
    visits: {
      read: true,
      create: true,
      update: true,
      delete: true,
      readVisitDetails: true,
    },
    patients: { read: true, create: true, update: true, delete: true },
    appointments: { read: true, create: true, update: true, delete: true },
    users: {
      read: true,
      create: true,
      update: true,
      delete: true,
      readMyProfile: true,
    },
    inventory: { read: true, create: true, update: true, delete: true },
    payments: { read: true, create: true, update: true, delete: true },
    approvals: { read: true, approve: true },
    analytics: { read: true, viewPerformanceReports: true },
    insuranceClaims: { read: true, create: true, update: true },
    insurance: { read: true, create: true, update: true },
    notifications: { read: true, create: true, update: true, delete: true },
    departments: { read: true, create: true, update: true, delete: true },
    tariff: { read: true, create: true, update: true, delete: true },
    performanceReports: { read: true },
    pharmacy: { read: true, update: true, dispense: true, delete: true },
    hie: {
      read: true,
      create: true,
      update: true,
      delete: true,
      approve: true,
      process: true,
    },
  },
  BRANCH_ADMIN: {
    clinics: { read: true, update: true },
    exams: { read: true, create: true, update: true },
    visits: { read: true, create: true, update: true, readVisitDetails: true },
    patients: { read: true, create: true, update: true },
    inventory: { read: true, create: true, update: true },
    payments: { read: true, create: true, update: true },
    approvals: { read: true },
    analytics: { read: true },
    tariff: { read: true },
    insuranceClaims: { read: true, create: true, update: true },
    insurance: { read: true, create: true, update: true },
    notifications: { read: true, create: true, update: true, delete: true },
    users: {
      read: true,
      create: true,
      update: true,
      delete: true,
      readMyProfile: true,
    },
    pharmacy: { read: true, update: true, dispense: true },
    hie: {
      read: true,
      create: true,
      update: true,
      approve: true,
      process: true,
    },
  },
  DOCTOR: {
    visits: {
      read: true,
      update: true,
      readVisitDetails: true,
      addExams: true,
    },
    patients: { read: true, update: true },
    prescription: {
      create: true,
      read: true,
      update: true,
      printPrescription: true,
    },
    exams: { read: true, create: true, update: true },
    analytics: { read: true },
    departments: { read: true },
    tariff: { read: true },
    insurance: { read: true, create: true, update: true },
    insuranceClaims: { read: true, create: true, update: true },
    notifications: { read: true, create: true, update: true, delete: true },
    users: { read: true, update: true, readMyProfile: true },
    appointments: { read: true, create: true, update: true, delete: true },
    inventory: { read: true },
    hie: { read: true, create: true },
  },
  NURSE: {
    visits: {
      read: true,
      update: true,
      create: true,
      readVisitDetails: true,
      updatePreConsultation: true,
    },
    patients: { read: true, update: true },
    exams: { read: true, create: true, update: true },
    insurance: { read: true, create: true, update: true },
    departments: { read: true },
    notifications: { read: true, create: true, update: true, delete: true },
    users: { read: true, update: true, readMyProfile: true },
    analytics: { read: true },
    appointments: { read: true, create: true, update: true, delete: true },
    tariff: { read: true },
    hie: { read: true, create: true, approve: true },
  },
  LAB_TECHNICIAN: {
    exams: { read: true, create: true, update: true, process: true },
    visits: { read: true, readVisitDetails: true, update: true },
    notifications: { read: true, create: true, update: true, delete: true },
    analytics: { read: true },
    tariff: { read: true },
    users: { read: true, readMyProfile: true },
  },
  RECEPTIONIST: {
    visits: { read: true, create: true, update: true },
    patients: { read: true, create: true, update: true },
    appointments: { read: true, create: true, update: true, delete: true },
    insurance: { read: true, create: true, update: true },
    payments: { read: true, create: true },
    notifications: { read: true, create: true, update: true, delete: true },
    users: { read: true, readMyProfile: true },
    departments: { read: true },
    hie: { read: true, create: true, approve: true },
  },
  PHARMACIST: {
    inventory: { read: true, update: true },
    prescription: { read: true, process: true },
    visits: { read: true, readVisitDetails: true },
    notifications: { read: true, create: true, update: true, delete: true },
    pharmacy: { read: true, update: true, dispense: true },
    users: { readMyProfile: true },
  },
  CASHIER: {
    payments: { read: true, create: true, update: true },
    approvals: { read: true },
    insurance: { read: true, create: true, update: true },
    insuranceClaims: { read: true, create: true, update: true },
    notifications: { read: true, create: true, update: true, delete: true },
    analytics: { read: true },
    tariff: { read: true },
    users: { read: true, readMyProfile: true },
    visits: {
      create: true,
      read: true,
      update: true,
      addPaymentMethod: true,
      dischargePatient: true,
      updateInitialCheckin: true,
    },
    departments: { read: true },
    hie: { read: true, create: true, approve: true },
  },
  MARKETING: {
    analytics: { read: true },
    notifications: { read: true, create: true, update: true, delete: true },
    users: { readMyProfile: true },
  },
  FLOW_MANAGER: {
    visits: { read: true, update: true, readVisitDetails: true, process: true },
    approvals: { read: true },
    notifications: { read: true, create: true, update: true, delete: true },
    users: { readMyProfile: true },
  },
  STOCK_MANAGER: {
    inventory: { read: true, create: true, update: true },
    notifications: { read: true, create: true, update: true, delete: true },
    analytics: { read: true },
    pharmacy: { read: true },
    users: { readMyProfile: true },
  },
  PATIENT: {
    appointments: { read: true, create: true, update: true, delete: true },
    visits: { read: true },
    prescription: { read: true },
    exams: { read: true },
  },
};

function isRole(value: string): value is Role {
  return value in ROLE_PERMISSIONS;
}

export function hasPermission(
  user: { role: string },
  resource: Resource,
  action: Action
): boolean {
  // SUPER_ADMIN bypasses all checks
  if (user.role === "SUPER_ADMIN") {
    return true;
  }

  if (!isRole(user.role)) {
    return false;
  }

  const roleConfig = ROLE_PERMISSIONS[user.role];
  if (!roleConfig) {
    return false;
  }

  const resourceConfig = roleConfig[resource];
  if (!resourceConfig) {
    return false;
  }

  return resourceConfig[action] === true;
}
