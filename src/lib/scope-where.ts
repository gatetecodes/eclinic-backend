import type { Scope } from "./request-scope";

type Mapping = {
  clinicId?: string; // e.g., "clinicId" or "patient.clinicId"
  branchId?: string; // e.g., "branchId" or "visit.branchId"
};

function setDeep(
  target: Record<string, unknown>,
  path: string,
  value: unknown
) {
  const parts = path.split(".");
  let current: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = current[key];
    if (typeof next !== "object" || next === null) {
      current[key] = {} as Record<string, unknown>;
    }
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = parts.at(-1);
  if (lastKey) {
    current[lastKey] = value;
  }
}

export function withScope(
  where: Record<string, unknown>,
  scope: Scope,
  mapping: Mapping = { clinicId: "clinicId", branchId: "branchId" }
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...where };

  if (typeof scope.clinicId === "number" && mapping.clinicId) {
    setDeep(result, mapping.clinicId, scope.clinicId);
  }
  if (typeof scope.branchId === "number" && mapping.branchId) {
    setDeep(result, mapping.branchId, scope.branchId);
  }

  return result;
}
