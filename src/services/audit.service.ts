import type { Context } from "hono";
import type { Prisma } from "../../generated/prisma/client";
import { db } from "../database/db";
import { logger } from "../lib/logger";
import type { AppEnv } from "../middlewares/auth.middleware";

/**
 * Every operator action that can be audited, mapped to the bucket and urgency it
 * is filed under. This registry is the single source of truth for the taxonomy:
 * `category`/`severity` are never passed by call sites, so an action cannot be
 * filed two different ways in two different places.
 *
 * Adding an action here is all that's needed to make it auditable — the union
 * type below is derived from the keys, so a typo at a call site is a type error.
 */
export const AUDIT_ACTIONS = {
  // --- clinic lifecycle -----------------------------------------------------
  "clinic.created": { category: "CONFIG", severity: "INFO" },
  "clinic.updated": { category: "CONFIG", severity: "INFO" },
  "clinic.suspend": { category: "BILLING", severity: "WARNING" },
  "clinic.reactivate": { category: "BILLING", severity: "NOTICE" },
  "clinic.archive": { category: "CONFIG", severity: "WARNING" },
  "clinic.subscriptionChanged": { category: "BILLING", severity: "NOTICE" },

  "clinic.planChanged": { category: "BILLING", severity: "NOTICE" },

  // --- entitlements ---------------------------------------------------------
  "entitlement.overridesUpdated": { category: "CONFIG", severity: "NOTICE" },

  // --- platform configuration ----------------------------------------------
  "plan.updated": { category: "BILLING", severity: "NOTICE" },
  "platform.settingsUpdated": { category: "CONFIG", severity: "NOTICE" },
  "product.terminologyUpdated": { category: "CONFIG", severity: "NOTICE" },

  // --- demo pipeline --------------------------------------------------------
  "demo.approved": { category: "CONFIG", severity: "INFO" },
  "demo.provisioned": { category: "CONFIG", severity: "INFO" },

  // --- staff membership & access -------------------------------------------
  "user.invited": { category: "MEMBERSHIP", severity: "INFO" },
  "user.roleChanged": { category: "MEMBERSHIP", severity: "NOTICE" },
  "user.revoked": { category: "MEMBERSHIP", severity: "WARNING" },
  "user.suspended": { category: "ACCESS", severity: "WARNING" },
  "user.reinstated": { category: "ACCESS", severity: "NOTICE" },
  "user.twoFactorReminded": { category: "SECURITY", severity: "INFO" },

  // --- impersonation --------------------------------------------------------
  // CRITICAL: an operator assuming a clinician's identity is the single most
  // sensitive action in the console.
  "impersonation.start": { category: "SECURITY", severity: "CRITICAL" },
  "impersonation.end": { category: "SECURITY", severity: "NOTICE" },

  // --- bulk data egress -----------------------------------------------------
  // CRITICAL by policy: exporting the audit trail is itself a privileged act and
  // the compliance tab counts these as bulk exports.
  "audit.exported": { category: "ACCESS", severity: "CRITICAL" },
} as const satisfies Record<
  string,
  { category: AuditCategoryValue; severity: AuditSeverityValue }
>;

type AuditCategoryValue =
  | "SECURITY"
  | "MEMBERSHIP"
  | "BILLING"
  | "ACCESS"
  | "CONFIG";

type AuditSeverityValue = "CRITICAL" | "WARNING" | "NOTICE" | "INFO";

/** Any action registered in {@link AUDIT_ACTIONS}. */
export type AuditAction = keyof typeof AUDIT_ACTIONS;

export type AuditTarget = {
  targetType: string;
  targetId?: number | null;
  metadata?: Prisma.InputJsonValue;
};

/**
 * Best-effort client IP. The app sits behind a proxy (see the custom node http
 * adapter in src/index.ts), so the socket address isn't reachable from the Hono
 * context — the forwarded headers are the only signal available.
 */
function clientIp(c: Context<AppEnv>): string | null {
  const forwardedFor = c.req.header("x-forwarded-for");
  if (forwardedFor) {
    // Left-most entry is the original client; the rest are proxy hops.
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  return c.req.header("x-real-ip") ?? null;
}

/**
 * Record a platform-operator action in the AdminAuditLog.
 *
 * Takes the request context rather than an actor id so the actor, their name and
 * their IP are captured consistently at every call site instead of being
 * threaded through by hand.
 *
 * Best-effort: an audit failure must never break the underlying operation, so
 * this swallows and logs its own errors. `targetType`/`targetId` are a loose
 * polymorphic pointer (e.g. "clinic"/42), not a hard FK.
 */
export async function writeAudit(
  c: Context<AppEnv>,
  action: AuditAction,
  target: AuditTarget
): Promise<void> {
  const sessionUser = c.get("user");
  const impersonatedBy = c.get("impersonatedBy");
  const { category, severity } = AUDIT_ACTIONS[action];

  // During an impersonation the actor is the operator, not the account being
  // acted as — anything else would file an operator's action under a clinician's
  // name. The impersonated identity is preserved in metadata so the trail still
  // shows whose session it went through.
  const actorId = impersonatedBy ?? sessionUser.id;
  const impersonationContext =
    impersonatedBy === undefined
      ? {}
      : {
          viaImpersonationOf: {
            id: sessionUser.id,
            name: sessionUser.name ?? null,
          },
        };

  try {
    await db.adminAuditLog.create({
      data: {
        actorId,
        // Resolve the operator's name rather than reusing the session user's when
        // impersonating; a lookup is cheap next to a mislabelled audit row.
        actorName: impersonatedBy
          ? await operatorName(impersonatedBy)
          : (sessionUser.name ?? null),
        action,
        category,
        severity,
        targetType: target.targetType,
        targetId: target.targetId ?? null,
        ipAddress: clientIp(c),
        metadata: mergeMetadata(target.metadata, impersonationContext),
      },
    });
  } catch (error) {
    logger.error("Failed to write admin audit log", {
      actorId,
      action,
      targetType: target.targetType,
      targetId: target.targetId,
      error,
    });
  }
}

/** Look up the impersonating operator's name for the audit row. */
async function operatorName(userId: number): Promise<string | null> {
  const operator = await db.user.findUnique({
    where: { id: userId },
    select: { name: true },
  });
  return operator?.name ?? null;
}

/**
 * Fold the impersonation context into whatever metadata the call site supplied.
 * Non-object metadata (an array or scalar) is nested rather than spread, so it is
 * never silently dropped.
 */
function mergeMetadata(
  metadata: Prisma.InputJsonValue | undefined,
  extra: Record<string, unknown>
): Prisma.InputJsonValue | undefined {
  if (Object.keys(extra).length === 0) {
    return metadata;
  }
  if (metadata === undefined) {
    return extra as Prisma.InputJsonValue;
  }
  if (
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata)
  ) {
    return { ...metadata, ...extra } as Prisma.InputJsonValue;
  }
  return { value: metadata, ...extra } as Prisma.InputJsonValue;
}
