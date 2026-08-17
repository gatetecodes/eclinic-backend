import type { Context } from "hono";
import { db } from "@/database/db";
import { AppError } from "@/lib/app-error";
import type { AppEnv } from "@/types/hono";

/**
 * Helpers shared by hie.controller.ts and registry.controller.ts.
 *
 * They live here rather than being exported from hie.controller.ts so the two
 * controllers never import each other — hie.controller.ts is already past 3000
 * lines and a controller-to-controller import is the start of a cycle.
 */

export function tenant(c: Context<AppEnv>) {
  const clinicId = c.get("clinicId");
  const user = c.get("user");
  if (!(clinicId && user)) {
    throw new AppError({
      status: 403,
      code: "HIE_TENANT_REQUIRED",
      message: "A clinic context is required",
    });
  }
  return { clinicId, user, actorId: Number(user.id) };
}

export function branchAdminScope(user: ReturnType<typeof tenant>["user"]) {
  if (user.role !== "BRANCH_ADMIN") {
    return;
  }
  if (!user.branchId) {
    throw new AppError({
      status: 403,
      code: "HIE_BRANCH_CONTEXT_REQUIRED",
      message: "A branch context is required",
    });
  }
  return user.branchId;
}

export async function audit(params: {
  clinicId: number;
  actorId: number;
  patientId?: number;
  action: string;
  capability: string;
  outcome: string;
  correlationId: string;
  metadata?: Record<string, string | number | boolean>;
}) {
  await db.hieAuditEvent.create({
    data: {
      clinicId: params.clinicId,
      actorId: params.actorId,
      patientId: params.patientId,
      action: params.action,
      capability: params.capability,
      purposeOfUse: "TREATMENT",
      outcome: params.outcome,
      correlationId: params.correlationId,
      metadata: params.metadata,
    },
  });
}

/**
 * Releases outbox events that were blocked purely because a mapping was missing.
 *
 * Called whenever a mapping becomes usable — on a manual attestation and now
 * also on a registry verification — so a publication that was waiting on the
 * mapping retries immediately rather than on its next natural backoff.
 */
export async function resumeReferenceBlockedEvents(
  clinicId: number,
  errorCodes: string[]
) {
  await db.hieOutboxEvent.updateMany({
    where: {
      clinicId,
      status: "BLOCKED",
      lastErrorCode: { in: errorCodes },
    },
    data: {
      status: "PENDING",
      dependencyReason: null,
      nextAttemptAt: new Date(),
      lockedAt: null,
    },
  });
}
