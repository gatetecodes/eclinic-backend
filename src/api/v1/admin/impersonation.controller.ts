import type { Context } from "hono";
import { jsonSuccess } from "@/lib/api-response";
import { AppError } from "@/lib/app-error";
import { auth } from "@/lib/auth";
import { httpCodes } from "@/lib/constants";
import { invalidateCachedUser } from "@/lib/session-cache";
import { writeAudit } from "@/services/audit.service";
import { Role, UserStatus } from "../../../../generated/prisma/client";
import { db } from "../../../database/db";
import { logger } from "../../../lib/logger";

const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;

/** True when a status blames the request rather than the server. */
const isClientError = (status: number) =>
  status >= HTTP_CLIENT_ERROR_MIN && status < HTTP_SERVER_ERROR_MIN;

/**
 * Why better-auth rejected a call, as a string fit to show an operator.
 *
 * Its error responses carry a JSON `{ code, message }` body. Without reading it,
 * a failure surfaces as nothing but "could not start the session" — which is a
 * dead end for whoever has to fix it, and is what this endpoint used to do (it
 * logged only the HTTP status). Clones the response so the body stays readable
 * for the caller. Falls back to the status line if the body is not JSON.
 */
async function authFailureReason(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as {
      code?: string;
      message?: string;
    };
    const reason = body.message ?? body.code;
    if (reason) {
      return reason;
    }
  } catch {
    // Body was empty or not JSON; the status line below is all we have.
  }
  return `${response.status} ${response.statusText}`.trim();
}

/**
 * Begin impersonating a user.
 *
 * Delegates the session swap to better-auth's admin plugin so the impersonated
 * session is a real session (correct cookie, expiry and `impersonatedBy`) rather
 * than something hand-rolled. This endpoint adds what the plugin does not: a
 * mandatory reason, the guards below, a CRITICAL audit entry, and cache
 * invalidation.
 *
 * The forwarded Set-Cookie is what actually swaps the operator's identity, so it
 * is copied onto our response verbatim.
 */
export const startImpersonation = async (c: Context) => {
  const targetId = Number(c.req.param("id"));
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw new AppError({
      status: httpCodes.BAD_REQUEST,
      code: "BAD_REQUEST",
      messageKey: "common.invalidId",
    });
  }
  const { reason } = c.get("validatedJson") as { reason: string };
  const operator = c.get("user");

  // Already impersonating: nesting would make the audit trail ambiguous about
  // who is really acting, and there would be no way back to the operator.
  if (c.get("impersonatedBy") !== undefined) {
    throw new AppError({
      status: httpCodes.CONFLICT,
      code: "IMPERSONATION_ALREADY_ACTIVE",
      messageKey: "impersonation.alreadyActive",
    });
  }

  if (targetId === operator.id) {
    throw new AppError({
      status: httpCodes.BAD_REQUEST,
      code: "IMPERSONATION_SELF",
      messageKey: "impersonation.self",
    });
  }

  const target = await db.user.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      name: true,
      role: true,
      status: true,
      clinicId: true,
      clinic: { select: { id: true, name: true } },
    },
  });
  if (!target) {
    throw new AppError({
      status: httpCodes.NOT_FOUND,
      code: "NOT_FOUND",
      messageKey: "impersonation.userNotFound",
    });
  }

  // Only a working account can be impersonated. An invited or suspended one has
  // no access to borrow, and impersonating it would show a broken session rather
  // than what the user actually sees. The status is named so the operator knows
  // what to fix rather than just that it was refused.
  if (target.status !== UserStatus.ACTIVE) {
    throw new AppError({
      status: httpCodes.BAD_REQUEST,
      code: "IMPERSONATION_TARGET_INACTIVE",
      messageKey: "impersonation.onlyActive",
      messageValues: { status: target.status },
    });
  }

  // Another operator's account is not a support target, and impersonating one
  // would be a lateral privilege move rather than a way to reproduce a tenant
  // issue.
  if (target.role === Role.SUPER_ADMIN) {
    throw new AppError({
      status: httpCodes.FORBIDDEN,
      code: "IMPERSONATION_TARGET_IS_OPERATOR",
      messageKey: "impersonation.operatorBlocked",
    });
  }

  const response = await auth.api.impersonateUser({
    body: { userId: String(targetId) },
    headers: c.req.raw.headers,
    asResponse: true,
  });

  if (!response.ok) {
    const failureReason = await authFailureReason(response);
    logger.error("Impersonation rejected by auth layer", {
      targetId,
      status: response.status,
      reason: failureReason,
    });
    throw new AppError({
      // Pass the auth layer's own status through when it blamed the request, so
      // a refusal reads as a refusal rather than as our server falling over.
      status: isClientError(response.status)
        ? response.status
        : httpCodes.INTERNAL_SERVER_ERROR,
      code: "IMPERSONATION_START_FAILED",
      messageKey: "impersonation.startFailed",
      messageValues: { reason: failureReason },
      // A 5xx withholds its message by default; this one is the auth layer's own
      // explanation, which is the whole point of surfacing it.
      exposeMessage: true,
    });
  }

  // The operator's own cached session is about to be replaced by the
  // impersonated one; drop it so nothing serves the pre-swap identity.
  invalidateCachedUser(c.req.header("cookie"));

  await writeAudit(c, "impersonation.start", {
    targetType: "user",
    targetId,
    metadata: {
      reason,
      targetName: target.name,
      targetRole: target.role,
      clinicId: target.clinicId,
    },
  });

  // Forward the session cookie(s) the auth layer issued — without these the
  // browser would never actually switch identity.
  for (const cookie of response.headers.getSetCookie()) {
    c.header("set-cookie", cookie, { append: true });
  }

  return jsonSuccess(c, {
    data: {
      user: {
        id: target.id,
        name: target.name,
        role: target.role,
        clinic: target.clinic,
      },
    },
  });
};

/**
 * End the current impersonation session and restore the operator's own.
 *
 * Mounted outside `requireSuperAdmin`: while impersonating, `c.get("user")` is the
 * tenant account, so an operator-gated route would refuse the very request that
 * ends the impersonation and strand them in the borrowed identity. Authorisation
 * comes from the session carrying `impersonatedBy` at all.
 */
export const stopImpersonation = async (c: Context) => {
  const impersonatedBy = c.get("impersonatedBy");
  if (impersonatedBy === undefined) {
    throw new AppError({
      status: httpCodes.BAD_REQUEST,
      code: "IMPERSONATION_NOT_ACTIVE",
      messageKey: "impersonation.notActive",
    });
  }

  const impersonated = c.get("user");

  // Audit before the swap, while the context still describes the impersonation.
  await writeAudit(c, "impersonation.end", {
    targetType: "user",
    targetId: impersonated.id,
    metadata: { targetName: impersonated.name ?? null },
  });

  const response = await auth.api.stopImpersonating({
    headers: c.req.raw.headers,
    asResponse: true,
  });

  // Purge the impersonated session's cache entry so the restored operator
  // identity is not shadowed by it.
  invalidateCachedUser(c.req.header("cookie"));

  if (!response.ok) {
    const failureReason = await authFailureReason(response);
    logger.error("Failed to stop impersonation at the auth layer", {
      status: response.status,
      impersonatedBy,
      reason: failureReason,
    });
    throw new AppError({
      status: isClientError(response.status)
        ? response.status
        : httpCodes.INTERNAL_SERVER_ERROR,
      code: "IMPERSONATION_END_FAILED",
      messageKey: "impersonation.endFailed",
      messageValues: { reason: failureReason },
      exposeMessage: true,
    });
  }

  for (const cookie of response.headers.getSetCookie()) {
    c.header("set-cookie", cookie, { append: true });
  }

  return jsonSuccess(c, { data: { restoredUserId: impersonatedBy } });
};

/**
 * Current impersonation state for the UI banner.
 *
 * Available to any authenticated user because the banner must render inside the
 * tenant dashboard too — an operator impersonating a nurse is looking at nurse
 * screens, and needs the exit affordance there.
 */
export const getImpersonationStatus = async (c: Context) => {
  const impersonatedBy = c.get("impersonatedBy");
  if (impersonatedBy === undefined) {
    return jsonSuccess(c, { data: { impersonating: false } });
  }

  const [operator, impersonated] = await Promise.all([
    db.user.findUnique({
      where: { id: impersonatedBy },
      select: { id: true, name: true, email: true },
    }),
    Promise.resolve(c.get("user")),
  ]);

  const clinic = impersonated.clinicId
    ? await db.clinic.findUnique({
        where: { id: impersonated.clinicId },
        select: { id: true, name: true },
      })
    : null;

  return jsonSuccess(c, {
    data: {
      impersonating: true,
      operator,
      user: {
        id: impersonated.id,
        name: impersonated.name,
        role: impersonated.role,
      },
      clinic,
    },
  });
};
