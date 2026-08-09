import type { Context } from "hono";
import { jsonError, jsonSuccess } from "@/lib/api-response";
import { httpCodes } from "@/lib/constants";
import { translate } from "@/lib/i18n";
import type { SupportedLocale } from "@/lib/locale";
import { invalidateUserSessions } from "@/lib/session-cache";
import { writeAudit } from "@/services/audit.service";
import { sendEmail } from "@/services/email.service";
import { createStaffAccount } from "@/services/staff-account.service";
import {
  type Prisma,
  type Role,
  UserStatus,
} from "../../../../generated/prisma/client";
import { db } from "../../../database/db";
import { logger } from "../../../lib/logger";
import { createVerificationEmail } from "../users/users.controller";

/**
 * Fields returned for every user the operator sees. Deliberately excludes
 * `password` and the document columns — the console never needs them, and a
 * cross-tenant endpoint is the wrong place to widen a user projection.
 */
const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  phone_number: true,
  clinicId: true,
  branchId: true,
  createdAt: true,
  isTwoFactorEnabled: true,
  clinic: { select: { id: true, name: true } },
} satisfies Prisma.UserSelect;

/** Parse a positive integer route param, or null when it isn't one. */
function userIdParam(c: Context): number | null {
  const id = Number(c.req.param("id"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

const invalidId = (c: Context) =>
  jsonError(c, {
    status: httpCodes.BAD_REQUEST,
    code: "BAD_REQUEST",
    messageKey: "common.invalidId",
  });

const serverError = (c: Context, error: unknown) =>
  jsonError(c, {
    status: httpCodes.INTERNAL_SERVER_ERROR,
    code: "INTERNAL_SERVER_ERROR",
    message: error instanceof Error ? error.message : "Internal Server Error",
  });

/**
 * Ask a staff member to enrol in 2FA. Returns whether the mail went out rather
 * than throwing, so the caller can record the attempt either way.
 */
async function sendTwoFactorReminder(
  email: string,
  name: string,
  locale: SupportedLocale
): Promise<boolean> {
  try {
    await sendEmail({
      to: email,
      subject: translate(locale, "email.twoFactorReminder.subject"),
      template: "two-factor-reminder",
      context: {
        previewTitle: translate(locale, "email.twoFactorReminder.subject"),
        logoAlt: "CareLogic",
        title: translate(locale, "email.twoFactorReminder.title"),
        greeting: translate(locale, "email.twoFactorReminder.greeting", {
          name,
        }),
        intro: translate(locale, "email.twoFactorReminder.intro"),
        buttonLabel: translate(locale, "email.twoFactorReminder.button"),
        settingsLink: `${process.env.APP_URL ?? ""}/dashboard/settings`,
        fallbackText: translate(locale, "email.verification.fallback"),
        signatureText: translate(locale, "email.verification.signature"),
        teamText: translate(locale, "email.verification.team"),
      },
    });
    return true;
  } catch (error) {
    logger.error("Failed to send 2FA reminder", { email, error });
    return false;
  }
}

/**
 * Invite a staff member into a clinic. Creates an INVITED account plus its
 * credential row and sends the verification email; the account becomes ACTIVE
 * only once the invitee verifies (see afterEmailVerification in src/lib/auth.ts).
 */
export const inviteUser = async (c: Context) => {
  try {
    const body = c.get("validatedJson") as {
      name: string;
      email: string;
      phone_number: string;
      clinicId: number;
      branchId?: number;
      role: Role;
    };

    const clinic = await db.clinic.findUnique({
      where: { id: body.clinicId },
      select: { id: true, name: true },
    });
    if (!clinic) {
      return jsonError(c, {
        status: httpCodes.NOT_FOUND,
        code: "NOT_FOUND",
        message: "Clinic not found",
      });
    }

    // Email is globally unique on User, so check before opening the transaction
    // to return a clear 409 rather than surfacing a P2002.
    const existing = await db.user.findUnique({
      where: { email: body.email },
      select: { id: true },
    });
    if (existing) {
      return jsonError(c, {
        status: httpCodes.CONFLICT,
        code: "UNIQUE_CONSTRAINT_VIOLATION",
        message: "A user with this email already exists",
      });
    }

    // Default to the clinic's head office when no branch is named, so an invited
    // user is never left branchless (which would break branch-scoped queries).
    const branchId =
      body.branchId ??
      (
        await db.branch.findFirst({
          where: { clinicId: body.clinicId, isHeadOffice: true },
          select: { id: true },
        })
      )?.id ??
      null;

    const user = await db.$transaction((tx) =>
      createStaffAccount(tx, {
        name: body.name,
        email: body.email,
        phone_number: body.phone_number,
        clinicId: body.clinicId,
        branchId,
        role: body.role,
      })
    );

    const verification = await createVerificationEmail(user.email, {
      locale: c.get("locale"),
    });
    if (!verification.success) {
      // The account exists and can be re-invited; failing the whole request would
      // leave the operator unsure whether it was created.
      logger.warn("Invited user but verification email failed", {
        userId: user.id,
        email: user.email,
        error: verification.error,
      });
    }

    await writeAudit(c, "user.invited", {
      targetType: "user",
      targetId: user.id,
      metadata: {
        clinicId: body.clinicId,
        role: body.role,
        emailSent: verification.success,
      },
    });

    return jsonSuccess(c, {
      status: httpCodes.CREATED,
      data: { id: user.id, emailSent: verification.success },
    });
  } catch (error) {
    return serverError(c, error);
  }
};

/**
 * Change a user's role. Sessions are invalidated because the role decides what
 * the permissions matrix allows — leaving a cached session in place would keep
 * the old role live for up to the cache's stale window.
 */
export const updateUserRole = async (c: Context) => {
  try {
    const userId = userIdParam(c);
    if (!userId) {
      return invalidId(c);
    }
    const { role } = c.get("validatedJson") as { role: Role };

    const target = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, clinicId: true },
    });
    if (!target) {
      return jsonError(c, {
        status: httpCodes.NOT_FOUND,
        code: "NOT_FOUND",
        message: "User not found",
      });
    }

    const updated = await db.user.update({
      where: { id: userId },
      data: { role },
      select: USER_SELECT,
    });
    invalidateUserSessions(userId);

    await writeAudit(c, "user.roleChanged", {
      targetType: "user",
      targetId: userId,
      metadata: { from: target.role, to: role, clinicId: target.clinicId },
    });

    return jsonSuccess(c, { data: updated });
  } catch (error) {
    return serverError(c, error);
  }
};

/**
 * Suspend or reinstate a user. Suspension writes BLOCKED, which `requireAuth`
 * refuses, and deletes the user's sessions so it takes effect immediately rather
 * than whenever their cookie happens to expire.
 */
export const updateUserStatus = async (c: Context) => {
  try {
    const userId = userIdParam(c);
    if (!userId) {
      return invalidId(c);
    }
    const { action, reason } = c.get("validatedJson") as {
      action: "suspend" | "reinstate";
      reason?: string;
    };

    const actor = c.get("user");
    if (actor.id === userId) {
      return jsonError(c, {
        status: httpCodes.BAD_REQUEST,
        code: "BAD_REQUEST",
        message: "You cannot change your own access status",
      });
    }

    const target = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true, clinicId: true },
    });
    if (!target) {
      return jsonError(c, {
        status: httpCodes.NOT_FOUND,
        code: "NOT_FOUND",
        message: "User not found",
      });
    }
    // An unaccepted invitation has no access to suspend; the operator should
    // revoke it instead.
    if (target.status === UserStatus.INVITED) {
      return jsonError(c, {
        status: httpCodes.BAD_REQUEST,
        code: "BAD_REQUEST",
        message: "This invitation has not been accepted yet",
      });
    }

    const suspending = action === "suspend";
    // `banned` and `status` are kept in lockstep: `banned` is what better-auth
    // enforces at session resolution, `status` is what the app and UI read. Setting
    // only one would let a suspended user keep working (or a reinstated one stay
    // locked out) depending on which layer answered first.
    const updated = await db.user.update({
      where: { id: userId },
      data: {
        status: suspending ? UserStatus.BLOCKED : UserStatus.ACTIVE,
        banned: suspending,
        banReason: suspending
          ? (reason ?? "Suspended by platform operator")
          : null,
        banExpires: null,
      },
      select: USER_SELECT,
    });

    if (suspending) {
      // Drop the persisted sessions too, not just the in-process cache, or the
      // cookie would still resolve against better-auth.
      await db.session.deleteMany({ where: { userId } });
    }
    invalidateUserSessions(userId);

    await writeAudit(c, suspending ? "user.suspended" : "user.reinstated", {
      targetType: "user",
      targetId: userId,
      metadata: { reason: reason ?? null, clinicId: target.clinicId },
    });

    return jsonSuccess(c, { data: updated });
  } catch (error) {
    return serverError(c, error);
  }
};

/**
 * Nudge a staff member to enrol in two-factor auth, from the clinic's compliance
 * tab.
 *
 * Records the reminder even when the email fails: the operator needs to know a
 * follow-up was attempted, and a silent no-op would make the button look broken.
 * No-ops for accounts already enrolled so a stale UI cannot send a pointless
 * reminder.
 */
export const remindTwoFactor = async (c: Context) => {
  try {
    const userId = userIdParam(c);
    if (!userId) {
      return invalidId(c);
    }

    const target = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        clinicId: true,
        isTwoFactorEnabled: true,
      },
    });
    if (!target) {
      return jsonError(c, {
        status: httpCodes.NOT_FOUND,
        code: "NOT_FOUND",
        message: "User not found",
      });
    }
    if (target.isTwoFactorEnabled) {
      return jsonError(c, {
        status: httpCodes.BAD_REQUEST,
        code: "BAD_REQUEST",
        message: "This account already has two-factor authentication enabled",
      });
    }

    const sent = await sendTwoFactorReminder(
      target.email,
      target.name,
      c.get("locale")
    );

    await writeAudit(c, "user.twoFactorReminded", {
      targetType: "user",
      targetId: userId,
      metadata: { clinicId: target.clinicId, emailSent: sent },
    });

    return jsonSuccess(c, { data: { id: userId, emailSent: sent } });
  } catch (error) {
    return serverError(c, error);
  }
};

/**
 * Revoke a user's access.
 *
 * Soft by necessity: User is referenced by ~40 clinical relations (authored notes,
 * recorded observations, processed payments), so deleting the row would either
 * fail on a foreign key or orphan medical records. INACTIVE is refused by
 * `requireAuth`, which is what "revoked" needs to mean.
 */
export const revokeUser = async (c: Context) => {
  try {
    const userId = userIdParam(c);
    if (!userId) {
      return invalidId(c);
    }

    const actor = c.get("user");
    if (actor.id === userId) {
      return jsonError(c, {
        status: httpCodes.BAD_REQUEST,
        code: "BAD_REQUEST",
        message: "You cannot revoke your own access",
      });
    }

    const target = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, clinicId: true, role: true },
    });
    if (!target) {
      return jsonError(c, {
        status: httpCodes.NOT_FOUND,
        code: "NOT_FOUND",
        message: "User not found",
      });
    }

    await db.user.update({
      where: { id: userId },
      data: {
        status: UserStatus.INACTIVE,
        // Ban at the auth layer too, so revocation holds even if the app-level
        // status check is ever bypassed.
        banned: true,
        banReason: "Access revoked by platform operator",
      },
    });
    await db.session.deleteMany({ where: { userId } });
    invalidateUserSessions(userId);

    await writeAudit(c, "user.revoked", {
      targetType: "user",
      targetId: userId,
      metadata: { clinicId: target.clinicId, role: target.role },
    });

    return jsonSuccess(c, { data: { id: userId } });
  } catch (error) {
    return serverError(c, error);
  }
};
