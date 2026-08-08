import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";
import { addHours } from "date-fns";
import { db } from "@/database/db";
import { translate } from "@/lib/i18n";
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  prefixLocalePath,
} from "@/lib/locale";
import { logger } from "@/lib/logger";
import { sendEmail } from "@/services/email.service";
import { activateVerifiedStaffAccount } from "@/services/staff-account.service";
import {
  type Branch,
  type Clinic,
  type PrismaClient,
  Role,
} from "../../generated/prisma/client";

const prisma = db;

const SESSION_EXPIRES_IN_DAYS = 7;
const SESSION_EXPIRES_IN = 60 * 60 * 24 * SESSION_EXPIRES_IN_DAYS; // 7 days
const SESSION_UPDATE_AGE = 60 * 60 * 24; // 1 day
const RESET_PASSWORD_TOKEN_TTL_HOURS = 1;
const SECONDS_PER_MINUTE = 60;
/**
 * Ceiling for an impersonation session, fixed at boot. Matches the
 * PlatformSetting.impersonationIdleTimeoutMinutes default; the operator-configured
 * value is enforced per-request at the impersonation endpoint, since better-auth
 * reads this option only once.
 */
const DEFAULT_IMPERSONATION_TIMEOUT_MINUTES = 15;

/**
 * Access-control role the admin plugin evaluates for SUPER_ADMIN.
 *
 * Scoped to `user: ["impersonate"]` on purpose. The plugin's own `adminAc` grants
 * create/ban/delete/set-role/set-password too, and we do not want those reachable
 * through the plugin at all — the audited endpoints in src/api/v1/admin own those
 * operations, and their plugin equivalents are blocked by
 * ADMIN_PLUGIN_ALLOWED_PATHS. Granting only what impersonation needs means a
 * future unblocked path still cannot bypass the audit trail.
 */
const superAdminAc = createAccessControl(defaultStatements).newRole({
  user: ["impersonate"],
});

const createResetPasswordToken = async (userId: number) => {
  await db.verification.deleteMany({
    where: {
      value: String(userId),
      identifier: { startsWith: "reset-password:" },
    },
  });
  const token = randomUUID();
  const expiresAt = addHours(new Date(), RESET_PASSWORD_TOKEN_TTL_HOURS);
  await db.verification.create({
    data: {
      identifier: `reset-password:${token}`,
      value: String(userId),
      expiresAt,
    },
  });
  return token;
};

const ALLOWED_VERIFICATION_CALLBACK_PATHS = new Set([
  "/auth/login",
  "/patient-portal/auth/login",
  "/auth/set-password",
]);
const ALLOWED_RESET_CALLBACK_PATHS = new Set(["/auth/set-password"]);

const resolveVerificationCallbackPath = (
  callbackURL: string | null,
  frontendOrigin: string
): { path: string; isSetPassword: boolean } | null => {
  if (!callbackURL) {
    return null;
  }
  try {
    const base = new URL(frontendOrigin);
    const resolved = new URL(callbackURL, base);
    if (resolved.origin !== base.origin) {
      return null;
    }
    if (!ALLOWED_VERIFICATION_CALLBACK_PATHS.has(resolved.pathname)) {
      return null;
    }
    return {
      path: `${resolved.pathname}${resolved.search}`,
      isSetPassword: resolved.pathname === "/auth/set-password",
    };
  } catch {
    return null;
  }
};

const resolveResetCallbackPath = (
  callbackURL: string | null,
  frontendOrigin: string
): string | null => {
  if (!callbackURL) {
    return null;
  }
  try {
    const base = new URL(frontendOrigin);
    const resolved = new URL(callbackURL, base);
    if (resolved.origin !== base.origin) {
      return null;
    }
    if (!ALLOWED_RESET_CALLBACK_PATHS.has(resolved.pathname)) {
      return null;
    }
    return `${resolved.pathname}${resolved.search}`;
  } catch {
    return null;
  }
};

const IS_NUMERIC_STRING = /^-?\d+$/;

// Wrap Prisma client to coerce string userId -> number for auth models
function createCoercingPrisma(client: PrismaClient): PrismaClient {
  const targetModels = new Set([
    "account",
    "session",
    "twofactorconfirmation",
    "user",
  ]);

  const isObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);

  const isNumericString = (s: unknown): s is string =>
    typeof s === "string" && IS_NUMERIC_STRING.test(s);

  type CoerceResult =
    | { coerced: true; value: number | string | Date | null }
    | { coerced: false };

  const coerceUserField = (key: string, value: unknown): CoerceResult => {
    if (key === "emailVerified" && typeof value === "boolean") {
      return { coerced: true, value: value ? new Date() : null };
    }
    if (
      (key === "licenseExpiration" || key === "licenseNumber") &&
      value === ""
    ) {
      return { coerced: true, value: null };
    }
    if (
      (key === "clinicId" || key === "branchId" || key === "id") &&
      isNumericString(value)
    ) {
      return { coerced: true, value: Number(value) };
    }
    return { coerced: false };
  };
  const coerceAccountRelatedField = (
    model: string,
    key: string,
    value: unknown
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
  ): CoerceResult => {
    if (model === "account") {
      if ((key === "userId" || key === "id") && isNumericString(value)) {
        return { coerced: true, value: Number(value) };
      }
      if (key === "accountId" && typeof value === "number") {
        return { coerced: true, value: String(value) };
      }
      return { coerced: false };
    }
    if (model === "session" || model === "twofactorconfirmation") {
      // Deliberately narrow: only userId/id are coerced to Int.
      //
      // Session.impersonatedBy must NOT be added here. The admin plugin defines it
      // as a String column and writes/compares it as a string; coercing it to a
      // number would make Prisma reject the write and silently break impersonation.
      if ((key === "userId" || key === "id") && isNumericString(value)) {
        return { coerced: true, value: Number(value) };
      }
      return { coerced: false };
    }
    return { coerced: false };
  };

  const coerceValue = (
    model: string,
    key: string,
    value: unknown
  ): CoerceResult => {
    // Only coerce on allowlisted keys per model
    if (model === "user") {
      return coerceUserField(key, value);
    }
    return coerceAccountRelatedField(model, key, value);
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Recursive coercion for Prisma args
  const coerceDeep = (v: unknown, model: string): void => {
    if (Array.isArray(v)) {
      for (const item of v) {
        coerceDeep(item, model);
      }
      return;
    }
    if (!isObject(v)) {
      return;
    }
    for (const key of Object.keys(v)) {
      const value = (v as Record<string, unknown>)[key];
      const result = coerceValue(model, key, value);
      if (result.coerced) {
        (v as Record<string, unknown>)[key] = result.value as unknown;
        continue;
      }
      // Handle nested where clauses like { where: { id: "1" } }
      if (key === "where" && isObject(value)) {
        coerceDeep(value, model);
        continue;
      }
      coerceDeep(value, model);
    }
  };

  const proxied = new Proxy(client as unknown as Record<string, unknown>, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string") {
        return original;
      }
      const model = prop.toLowerCase();
      if (!targetModels.has(model)) {
        return original;
      }
      if (!isObject(original)) {
        return original;
      }
      return new Proxy(original as Record<string, unknown>, {
        get(modelTarget, methodProp, r2) {
          const method = Reflect.get(modelTarget, methodProp, r2);
          if (typeof method !== "function") {
            return method;
          }
          return (
            args: Record<string, unknown> | undefined,
            ...rest: unknown[]
          ) => {
            if (isObject(args)) {
              coerceDeep(args, model);
            }
            if (model === "account") {
              const _where = (args as Record<string, unknown> | undefined)
                ?.where;
            }
            return (method as (...a: unknown[]) => unknown).apply(modelTarget, [
              args,
              ...rest,
            ]);
          };
        },
      });
    },
  });

  return proxied as unknown as PrismaClient;
}

const prismaForAuth = createCoercingPrisma(prisma);

const backendUrl = process.env.BACKEND_URL;
const frontendUrl = process.env.APP_URL;
const nextUpUrl = process.env.NEXT_UP_URL || "";
const parseTrustedOrigins = (value?: string) =>
  (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

const trustedOrigins = [frontendUrl, nextUpUrl]
  .map((origin) => origin?.trim())
  .filter(Boolean) as string[];

const normalizedEnvTrustedOrigins = parseTrustedOrigins(
  process.env.BETTER_AUTH_TRUSTED_ORIGINS
);

if (process.env.BETTER_AUTH_TRUSTED_ORIGINS !== undefined) {
  process.env.BETTER_AUTH_TRUSTED_ORIGINS =
    normalizedEnvTrustedOrigins.join(",");
}
const isProdLike =
  process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging";
const cookieDomain = isProdLike
  ? process.env.COOKIE_DOMAIN || ".usecarelogic.com"
  : undefined;

if (!(backendUrl && frontendUrl)) {
  throw new Error("BACKEND_URL or APP_URL is not set");
}

if (!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)) {
  throw new Error("GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is not set");
}

export const auth = betterAuth({
  baseURL: backendUrl,
  trustedOrigins: [...trustedOrigins, ...normalizedEnvTrustedOrigins],
  rateLimit: {
    enabled: true,
    customRules: {
      "/get-session": false,
    },
  },
  database: prismaAdapter(prismaForAuth, {
    provider: "postgresql",
  }),
  // Mount under v1 router at /auth so the final path is /api/v1/auth/*
  basePath: "/auth",
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    requireEmailVerification: true,
    sendResetPassword: ({ user, url, token }) => {
      const locale =
        normalizeLocale(
          (user as { preferredLocale?: string | null }).preferredLocale
        ) ?? DEFAULT_LOCALE;

      let callbackURL: string | null = null;
      if (url) {
        try {
          callbackURL = new URL(url).searchParams.get("callbackURL");
        } catch {
          callbackURL = null;
        }
      }

      const resolvedCallbackPath = resolveResetCallbackPath(
        callbackURL,
        frontendUrl
      );

      const resetPath = resolvedCallbackPath
        ? resolvedCallbackPath
        : prefixLocalePath(locale, "/auth/set-password");
      const resetUrl = new URL(resetPath, frontendUrl);
      resetUrl.searchParams.set("token", token);

      return sendEmail({
        to: user.email,
        subject: translate(locale, "auth.resetPasswordSubject"),
        template: "password-reset",
        context: {
          resetLink: resetUrl.toString(),
          previewTitle: translate(locale, "email.reset.previewTitle"),
          logoAlt: translate(locale, "email.reset.logoAlt"),
          title: translate(locale, "email.reset.title"),
          intro: translate(locale, "email.reset.intro"),
          buttonLabel: translate(locale, "email.reset.button"),
          fallbackText: translate(locale, "email.reset.fallback"),
          ignoreText: translate(locale, "email.reset.ignore"),
          signatureText: translate(locale, "email.reset.signature"),
          teamText: translate(locale, "email.reset.team"),
        },
      }).catch((err) => {
        logger.error("Better Auth: failed to send reset password email", {
          email: user.email,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    /**
     * Accepting an invitation is exactly "verified your email", so this is where
     * an INVITED account becomes ACTIVE. Without it, invited staff would show as
     * Invited in the platform console forever, even after signing in.
     */
    afterEmailVerification: async (user) => {
      const userId = Number(user.id);
      if (Number.isFinite(userId) && userId > 0) {
        await activateVerifiedStaffAccount(userId);
      }
    },
    sendVerificationEmail: async ({ user, url, token }) => {
      const userId = Number(user.id);
      const dbUserRole =
        Number.isFinite(userId) && userId > 0
          ? await prisma.user.findUnique({
              where: { id: userId },
              select: { role: true },
            })
          : null;
      const isPatient = dbUserRole?.role === "PATIENT";
      const verifyPath = isPatient
        ? "/patient-portal/auth/verify-email"
        : "/auth/verify-email";
      const defaultNextPath = isPatient
        ? "/patient-portal/auth/login?verified=1"
        : "/auth/login?verified=1";
      let nextPath = defaultNextPath;

      let callbackURL: string | null = null;
      if (url) {
        try {
          callbackURL = new URL(url).searchParams.get("callbackURL");
        } catch {
          callbackURL = null;
        }
      }

      const resolvedCallback = resolveVerificationCallbackPath(
        callbackURL,
        frontendUrl
      );
      if (resolvedCallback) {
        if (resolvedCallback.isSetPassword) {
          const resetToken = await createResetPasswordToken(Number(user.id));
          const setPasswordUrl = new URL(resolvedCallback.path, frontendUrl);
          setPasswordUrl.searchParams.set("token", resetToken);
          nextPath = `${setPasswordUrl.pathname}${setPasswordUrl.search}`;
        } else {
          nextPath = resolvedCallback.path;
        }
      }
      const locale =
        normalizeLocale(
          (user as { preferredLocale?: string | null }).preferredLocale
        ) ?? DEFAULT_LOCALE;
      const localizedVerifyPath = isPatient
        ? verifyPath
        : prefixLocalePath(locale, verifyPath);
      const localizedNextPath =
        isPatient || nextPath.startsWith("/patient-portal")
          ? nextPath
          : prefixLocalePath(locale, nextPath);
      const verificationUrl = new URL(localizedVerifyPath, frontendUrl);
      verificationUrl.searchParams.set("token", token);
      verificationUrl.searchParams.set("next", localizedNextPath);

      return sendEmail({
        to: user.email,
        subject: translate(locale, "auth.verifyAccountSubject"),
        template: "verification",
        context: {
          verificationLink: verificationUrl.toString(),
          previewTitle: translate(locale, "email.verification.previewTitle"),
          logoAlt: translate(locale, "email.verification.logoAlt"),
          title: translate(locale, "email.verification.title"),
          intro: translate(locale, "email.verification.intro"),
          buttonLabel: translate(locale, "email.verification.button"),
          fallbackText: translate(locale, "email.verification.fallback"),
          ignoreText: translate(locale, "email.verification.ignore"),
          signatureText: translate(locale, "email.verification.signature"),
          teamText: translate(locale, "email.verification.team"),
        },
      }).catch((err) => {
        logger.error("Better Auth: failed to send verification email", {
          email: user.email,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
  },
  socialProviders: {
    // google: {
    //   clientId: process.env.GOOGLE_CLIENT_ID!,
    //   clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    // },
    // github: {
    //   clientId: process.env.GITHUB_CLIENT_ID!,
    //   clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    // },
  },
  session: {
    expiresIn: SESSION_EXPIRES_IN,
    updateAge: SESSION_UPDATE_AGE,
  },
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: true,
      },
      patientId: {
        type: "number",
        required: false,
      },
      clinicId: {
        type: "number",
        required: false,
      },
      branchId: {
        type: "number",
        required: false,
      },
      preferredLocale: {
        type: "string",
        required: false,
      },
      status: {
        type: "string",
        required: true,
        defaultValue: "ACTIVE",
      },
      phone_number: {
        type: "string",
        required: true,
      },
      consultationFee: {
        type: "number",
        required: false,
      },
      licenseExpiration: {
        type: "date",
        required: false,
      },
      licenseNumber: {
        type: "string",
        required: false,
      },
      license_document: {
        type: "string",
        required: false,
      },
      diploma_document: {
        type: "string",
        required: false,
      },
      highestEducation: {
        type: "string",
        required: false,
      },
      isTwoFactorEnabled: {
        type: "boolean",
        required: false,
        defaultValue: false,
      },
    },
  },
  advanced: {
    cookies: {
      session_token: {
        attributes: {
          ...(cookieDomain ? { domain: cookieDomain } : {}),
          secure: isProdLike,
          sameSite: "lax",
          path: "/",
          httpOnly: true,
        },
      },
    },
    crossSubDomainCookies: {
      enabled: Boolean(cookieDomain),
      domains: cookieDomain ? [cookieDomain] : [],
    },
    useSecureCookies: isProdLike,
    database: {
      generateId: false,
    },
  },
  plugins: [
    /**
     * Registered for impersonation only.
     */
    admin({
      adminRoles: [Role.SUPER_ADMIN],
      roles: { [Role.SUPER_ADMIN]: superAdminAc },
      impersonationSessionDuration:
        DEFAULT_IMPERSONATION_TIMEOUT_MINUTES * SECONDS_PER_MINUTE,
    }),
  ],
});

export type Session = Omit<typeof auth.$Infer.Session, "user"> & {
  user: typeof auth.$Infer.Session.user & {
    id: number;
    role: string;
    patientId?: number;
    clinicId?: number;
    branchId?: number;
    preferredLocale?: string | null;
    clinic?: Clinic;
    branch?: Branch;
  };
};
export type User = Session["user"];
