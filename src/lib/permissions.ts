import type { Role } from "../../generated/prisma";
import type { Action, Resource } from "../types/access";

export type PermissionConfig = Partial<
  Record<Resource, Partial<Record<Action, boolean>>>
>;

export const ROLE_PERMISSIONS: Record<Role, PermissionConfig> = {
  SUPER_ADMIN: {
    // SUPER_ADMIN has implicit allow via hasPermission; matrix here can remain sparse
  },
  CLINIC_ADMIN: {
    visits: {
      read: true,
      create: true,
      update: true,
      delete: true,
      readVisitDetails: true,
    },
    patients: { read: true, create: true, update: true, delete: true },
    appointments: { read: true, create: true, update: true, delete: true },
    users: { read: true, create: true, update: true, delete: true },
    inventory: { read: true, create: true, update: true, delete: true },
    payments: { read: true, create: true, update: true, delete: true },
    approvals: { read: true, approve: true },
    analytics: { read: true, viewPerformanceReports: true },
    insuranceClaims: { read: true, create: true, update: true },
    insurance: { read: true, create: true, update: true },
    notifications: { read: true, create: true, update: true, delete: true },
    departments: { read: true, create: true, update: true, delete: true },
  },
  BRANCH_ADMIN: {
    visits: { read: true, create: true, update: true, readVisitDetails: true },
    patients: { read: true, create: true, update: true },
    inventory: { read: true, create: true, update: true },
    payments: { read: true, create: true, update: true },
    approvals: { read: true },
    analytics: { read: true },
    insuranceClaims: { read: true, create: true, update: true },
    insurance: { read: true, create: true, update: true },
    notifications: { read: true, create: true, update: true, delete: true },
  },
  DOCTOR: {
    visits: { read: true, update: true, readVisitDetails: true },
    patients: { read: true, update: true },
    prescription: {
      create: true,
      read: true,
      update: true,
      printPrescription: true,
    },
    exams: { read: true, create: true, update: true },
    analytics: { read: true },
    insurance: { read: true, create: true, update: true },
    notifications: { read: true, create: true, update: true, delete: true },
  },
  NURSE: {
    visits: { read: true, update: true, readVisitDetails: true },
    patients: { read: true, update: true },
    exams: { read: true, create: true, update: true },
    insurance: { read: true, create: true, update: true },
    notifications: { read: true, create: true, update: true, delete: true },
  },
  LAB_TECHNICIAN: {
    exams: { read: true, create: true, update: true, process: true },
    visits: { read: true, readVisitDetails: true },
    notifications: { read: true, create: true, update: true, delete: true },
  },
  RECEPTIONIST: {
    visits: { read: true, create: true, update: true },
    patients: { read: true, create: true, update: true },
    appointments: { read: true, create: true, update: true, delete: true },
    payments: { read: true, create: true },
    notifications: { read: true, create: true, update: true, delete: true },
  },
  PHARMACIST: {
    inventory: { read: true, update: true },
    prescription: { read: true, process: true },
    visits: { read: true, readVisitDetails: true },
    notifications: { read: true, create: true, update: true, delete: true },
  },
  CASHIER: {
    payments: { read: true, create: true, update: true },
    approvals: { read: true },
    insurance: { read: true, create: true, update: true },
    notifications: { read: true, create: true, update: true, delete: true },
  },
  MARKETING: {
    analytics: { read: true },
    notifications: { read: true, create: true, update: true, delete: true },
  },
  FLOW_MANAGER: {
    visits: { read: true, update: true, readVisitDetails: true, process: true },
    approvals: { read: true },
    notifications: { read: true, create: true, update: true, delete: true },
  },
  STOCK_MANAGER: {
    inventory: { read: true, create: true, update: true },
    notifications: { read: true, create: true, update: true, delete: true },
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
