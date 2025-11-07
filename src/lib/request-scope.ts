import type { User } from "./auth";
import { isSuperAdmin } from "./constants";

export type Scope = {
  clinicId?: number;
  branchId?: number;
};

function toNumber(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number.parseInt(value, 10);
    return Number.isNaN(n) ? undefined : n;
  }
  return;
}

export function getScope(user: User, query: Record<string, unknown>): Scope {
  if (isSuperAdmin(user?.role)) {
    const clinicId = toNumber(query.clinicId);
    const branchId = toNumber(query.branchId);
    return {
      clinicId,
      branchId,
    };
  }

  const clinicId = user?.clinicId ?? user?.clinic?.id;
  const branchId = user?.branchId ?? user?.branch?.id;

  return {
    clinicId,
    branchId,
  };
}
