import { randomBytes, randomUUID } from "node:crypto";
import {
  addDays,
  addHours,
  endOfDay,
  parseISO,
  startOfDay,
  startOfWeek,
} from "date-fns";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { jsonError, jsonSuccess } from "@/lib/api-response";
import { AppError } from "@/lib/app-error.ts";
import { httpCodes } from "@/lib/constants.ts";
import { translate } from "@/lib/i18n";
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  prefixLocalePath,
} from "@/lib/locale";
import {
  ActivityType,
  type EducationLevel,
  type Prisma,
  Role,
  type StaffTimesheet,
  type TimesheetPeriod,
  type User,
  UserStatus,
} from "../../../../generated/prisma/client";
import { db } from "../../../database/db";
import { logActivity } from "../../../helpers/activity-helpers.ts";
import { hashCredentialPassword } from "../../../helpers/auth-helper.ts";
import { buildQueryOptions } from "../../../helpers/query-helper";
import {
  isWorkingNowForWeekly,
  resolveTargetDate,
} from "../../../helpers/user-helper";
import { searchParamsSchema } from "../../../lib/common-validation";
import { logger } from "../../../lib/logger";
import { sendEmail } from "../../../services/email.service";
import {
  CACHE_KEYS,
  invalidateCache,
} from "../../../services/redis.service.ts";
import {
  buildNonExpiredTimesheetSet,
  buildWeeklyTimesheetMapForUsers,
  filterValidAvailability,
  formatLicenseExpiration,
  resolveWeekStartDate,
  truthyQueryValue,
} from "../../../services/users.service";
// token helpers defined below
import {
  createDoctorSchema,
  createUserSchema,
  editDoctorSchema,
  type UpsertTimesheetInput,
  updateUserSchema,
} from "./users.validation";

const EMAIL_RETRY_DELAY_MS = 1000;

const generateTemporaryPassword = () => randomBytes(24).toString("base64url");

const signUpUserWithBetterAuth = async (
  backendUrl: string,
  appUrl: string,
  payload: Record<string, unknown>
) => {
  const signUpUrl = new URL("/api/v1/auth/sign-up/email", backendUrl);
  const response = await fetch(signUpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: appUrl,
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
};

const cleanupFailedStaffUser = async (
  userId: number,
  email: string,
  context: string
) => {
  try {
    await db.doctorAvailability.deleteMany({
      where: { doctorId: userId },
    });
  } catch (error) {
    logger.warn("Cleanup: failed to delete doctor availability", {
      userId,
      email,
      context,
      error,
    });
  }

  try {
    await db.user.update({
      where: { id: userId },
      data: {
        clinicalDepartments: { set: [] },
      },
    });
  } catch (error) {
    logger.warn("Cleanup: failed to clear clinical departments", {
      userId,
      email,
      context,
      error,
    });
  }

  try {
    await db.user.delete({ where: { id: userId } });
  } catch (error) {
    logger.warn("Cleanup: failed to delete user", {
      userId,
      email,
      context,
      error,
    });
  }

  try {
    await db.verification.deleteMany({
      where: {
        OR: [{ value: String(userId) }, { identifier: { contains: email } }],
      },
    });
  } catch (error) {
    logger.warn("Cleanup: failed to delete verification records", {
      userId,
      email,
      context,
      error,
    });
  }
};

const sendVerificationEmailSafe = async (
  email: string,
  token: string,
  nextPath?: string,
  locale?: string
): Promise<{ success: boolean; error?: unknown }> => {
  try {
    const context = getVerificationTemplateContext(token, nextPath, locale);
    await sendEmail({
      to: email,
      subject: translate(locale, "auth.verifyAccountSubject"),
      template: "verification",
      context,
    });
    return { success: true };
  } catch (error) {
    logger.error("Failed to send verification email", { email, error });
    return { success: false, error };
  }
};

// biome-ignore lint/nursery/useMaxParams: <>
const sendVerificationEmailWithRetry = async (
  email: string,
  token: string,
  nextPath?: string,
  locale?: string,
  maxRetries = 3
): Promise<{ success: boolean; error?: unknown }> => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await sendVerificationEmailSafe(
      email,
      token,
      nextPath,
      locale
    );
    if (result.success) {
      return result;
    }
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, EMAIL_RETRY_DELAY_MS));
    }
  }
  return {
    success: false,
    error: new Error("Failed to send verification email after retries"),
  };
};

type AuthenticatedUser = {
  id: number;
  role: Role;
  clinicId?: number;
  branchId?: number;
};

const userProfileInclude = {
  clinicalDepartments: true,
  clinic: {
    select: {
      id: true,
      name: true,
      defaultLocale: true,
      logo: true,
      contactPhone: true,
      contactEmail: true,
      subscriptionStatus: true,
      subscriptionPlan: true,
      isQueueManagementEnabled: true,
    },
  },
  branch: {
    select: {
      id: true,
      name: true,
      address: true,
      contactPhone: true,
      contactEmail: true,
      isHeadOffice: true,
    },
  },
  accounts: {
    select: {
      id: true,
    },
    take: 1,
  },
} as const;

const generateVerificationToken = async (email: string) => {
  await db.verificationToken.deleteMany({ where: { email } });
  return db.verificationToken.create({
    data: {
      email,
      token: randomUUID(),
      expires: addHours(new Date(), 1),
    },
  });
};

const getVerificationTemplateContext = (
  token: string,
  nextPath?: string,
  locale?: string
) => {
  const appUrl = process.env.APP_URL ?? process.env.FRONTEND_URL;
  if (!appUrl) {
    throw new Error("APP_URL is not configured");
  }
  const resolvedLocale = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  const localizedVerificationPath = prefixLocalePath(
    resolvedLocale,
    "/auth/new-verification"
  );
  const verificationUrl = new URL(localizedVerificationPath, appUrl);
  verificationUrl.searchParams.set("token", token);
  if (nextPath) {
    const localizedNextPath =
      nextPath.startsWith("/patient-portal") ||
      nextPath.startsWith(`/${resolvedLocale}/`)
        ? nextPath
        : prefixLocalePath(resolvedLocale, nextPath);
    verificationUrl.searchParams.set("next", localizedNextPath);
  }
  return {
    verificationLink: verificationUrl.toString(),
    previewTitle: translate(resolvedLocale, "email.verification.previewTitle"),
    logoAlt: translate(resolvedLocale, "email.verification.logoAlt"),
    title: translate(resolvedLocale, "email.verification.title"),
    intro: translate(resolvedLocale, "email.verification.intro"),
    buttonLabel: translate(resolvedLocale, "email.verification.button"),
    fallbackText: translate(resolvedLocale, "email.verification.fallback"),
    ignoreText: translate(resolvedLocale, "email.verification.ignore"),
    signatureText: translate(resolvedLocale, "email.verification.signature"),
    teamText: translate(resolvedLocale, "email.verification.team"),
  } as const;
};

export const createVerificationEmail = async (
  email: string,
  options?: { nextPath?: string; locale?: string }
) => {
  const token = await generateVerificationToken(email);
  return sendVerificationEmailWithRetry(
    email,
    token.token,
    options?.nextPath,
    options?.locale
  );
};

export const resendVerificationEmail = async (c: Context) => {
  try {
    const body = await c.get("validatedJson");
    const { email } = body as { email: string };

    const user = await db.user.findUnique({ where: { email } });
    if (!user || user.role === "PATIENT" || user.emailVerified) {
      return jsonSuccess(c, {
        status: httpCodes.OK,
        messageKey: "users.resendVerificationIfExists",
      });
    }

    const appUrl = process.env.APP_URL ?? process.env.FRONTEND_URL;
    if (!appUrl) {
      logger.error("APP_URL is not configured");
      return jsonSuccess(c, {
        status: httpCodes.OK,
        messageKey: "users.resendVerificationIfExists",
      });
    }

    const backendUrl = process.env.BACKEND_URL;
    if (!backendUrl) {
      logger.error("BACKEND_URL is not configured");
      return jsonSuccess(c, {
        status: httpCodes.OK,
        messageKey: "users.resendVerificationIfExists",
      });
    }

    const locale = normalizeLocale(user.preferredLocale) ?? c.get("locale");
    const callbackURL = `${appUrl}${prefixLocalePath(locale, "/auth/set-password")}`;
    const resendUrl = new URL(
      "/api/v1/auth/send-verification-email",
      backendUrl
    );
    const response = await fetch(resendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: appUrl,
      },
      body: JSON.stringify({ email, callbackURL }),
    });

    if (!response.ok) {
      logger.warn("Resend verification email failed", { email });
    }

    return jsonSuccess(c, {
      status: httpCodes.OK,
      messageKey: "users.resendVerificationIfExists",
    });
  } catch (error) {
    logger.error("Failed to resend verification email", { error });
    return jsonSuccess(c, {
      status: httpCodes.OK,
      messageKey: "users.resendVerificationIfExists",
    });
  }
};

// helper functions moved to services/users.service.ts

export const getClinicUsers = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    if (authUser.role !== "CLINIC_ADMIN") {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const params = searchParamsSchema.parse(c.req.query());
    const includeWeeklyTimesheet = truthyQueryValue(
      params.includeWeeklyTimesheet
    );
    const weekStartDate = includeWeeklyTimesheet
      ? resolveWeekStartDate(params.weekStart)
      : undefined;

    const queryOptions = buildQueryOptions<User>(params);
    const { where, orderBy, ...restOptions } = queryOptions;

    const listWhere: Prisma.UserWhereInput = {
      ...(where as Prisma.UserWhereInput),
      clinicId: authUser.clinicId,
      role: {
        notIn: ["DOCTOR", "NURSE"],
      },
    };

    const users = await db.user.findMany({
      ...restOptions,
      where: listWhere,
      orderBy: orderBy as Prisma.UserOrderByWithRelationInput,
      include: {
        clinicalDepartments: {
          select: { id: true, name: true },
        },
        branch: {
          select: { id: true, name: true },
        },
        _count: {
          select: {
            doctorEvents: true,
            doctorVisits: true,
          },
        },
      },
    });

    const userIds = users.map((user) => user.id);
    const usersWithNonExpiredTimesheet =
      await buildNonExpiredTimesheetSet(userIds);
    const weeklyTimesheetByUserId = includeWeeklyTimesheet
      ? await buildWeeklyTimesheetMapForUsers(userIds, weekStartDate)
      : {};

    // Add hasNonExpiredTimesheet field (and weeklyTimesheet if requested) to each user
    const usersWithTimesheetFlag = users.map((user) => {
      const base = {
        ...user,
        hasNonExpiredTimesheet: usersWithNonExpiredTimesheet.has(user.id),
      };
      if (includeWeeklyTimesheet) {
        return {
          ...base,
          weeklyTimesheet: weeklyTimesheetByUserId[user.id] ?? [],
        };
      }
      return base;
    });

    const totalCount = await db.user.count({ where: listWhere });
    const take = restOptions.take ?? 0;
    const pageCount = take > 0 ? Math.ceil(totalCount / take) : 0;

    return c.json(
      {
        data: usersWithTimesheetFlag,
        totalCount,
        pageCount,
        ...(includeWeeklyTimesheet && weekStartDate
          ? { weekStart: weekStartDate.toISOString() }
          : {}),
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to list clinic users", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

//biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
export const addNewUser = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    if (authUser.role !== "CLINIC_ADMIN") {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const body = await c.get("validatedJson");
    const parsed = createUserSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const {
      name,
      email,
      role,
      phone_number,
      password,
      highestEducation,
      licenseNumber,
      licenseExpiration,
      license_document,
      diploma_document,
      departments,
      weeklyAvailability,
    } = parsed.data;

    const existingUser = await db.user.findUnique({ where: { email } });
    if (existingUser) {
      return c.json(
        { error: "User with this email already exists" },
        httpCodes.CONFLICT as ContentfulStatusCode
      );
    }

    const providedPassword =
      typeof password === "string" && password.length > 0;
    const rawPassword = providedPassword
      ? password
      : generateTemporaryPassword();
    const isDoctor = role === "DOCTOR";

    const appUrl = process.env.APP_URL ?? process.env.FRONTEND_URL;
    if (!appUrl) {
      throw new Error("APP_URL is not configured");
    }

    const backendUrl = process.env.BACKEND_URL;
    if (!backendUrl) {
      throw new Error("BACKEND_URL is not configured");
    }

    const callbackURL = providedPassword
      ? `${appUrl}/auth/login?verified=1`
      : `${appUrl}/auth/set-password`;

    const signUpPayload: Record<string, unknown> = {
      email,
      password: rawPassword,
      name,
      role,
      phone_number,
      clinicId: authUser.clinicId,
      branchId: authUser.branchId,
      callbackURL,
      highestEducation,
      licenseNumber,
      license_document,
      diploma_document,
      licenseExpiration: formatLicenseExpiration(licenseExpiration),
    };

    const { response, data } = await signUpUserWithBetterAuth(
      backendUrl,
      appUrl,
      signUpPayload
    );

    if (
      !response.ok ||
      (data && typeof data === "object" && data !== null && "error" in data)
    ) {
      const message =
        (data as { error?: { message?: string } | string })?.error &&
        typeof (data as { error?: { message?: string } | string }).error ===
          "string"
          ? (data as { error?: string }).error
          : (data as { error?: { message?: string } })?.error?.message;
      return c.json(
        { error: message || "Failed to create user" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const createdUser = await db.user.findUnique({ where: { email } });
    if (!createdUser) {
      return c.json(
        { error: "User created but could not be retrieved" },
        httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
      );
    }

    const updateData: Prisma.UserUpdateInput = {
      highestEducation: highestEducation as EducationLevel | undefined,
      licenseNumber: licenseNumber || null,
      licenseExpiration: formatLicenseExpiration(licenseExpiration),
      license_document: license_document || null,
      diploma_document: diploma_document || null,
      clinicalDepartments:
        isDoctor && departments && departments.length > 0
          ? {
              connect: departments.map((departmentId) => ({
                id: departmentId,
              })),
            }
          : undefined,
    };

    try {
      if (isDoctor) {
        await db.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: createdUser.id },
            data: updateData,
          });
          if (weeklyAvailability && weeklyAvailability.length > 0) {
            const availabilityData = filterValidAvailability(
              weeklyAvailability
            ).map((slot) => ({
              doctorId: createdUser.id,
              startDayOfWeek: slot.startDayOfWeek,
              startTime: slot.startTime,
              endDayOfWeek: slot.endDayOfWeek,
              endTime: slot.endTime,
            }));
            if (availabilityData.length > 0) {
              await tx.doctorAvailability.createMany({
                data: availabilityData,
              });
            }
          }
        });
      } else if (
        updateData.highestEducation ||
        updateData.licenseNumber ||
        updateData.licenseExpiration ||
        updateData.license_document ||
        updateData.diploma_document
      ) {
        await db.user.update({
          where: { id: createdUser.id },
          data: updateData,
        });
      }
    } catch (error) {
      await cleanupFailedStaffUser(
        createdUser.id,
        createdUser.email,
        "addNewUser"
      );
      logger.error("Failed to enrich created user", {
        error,
        userId: createdUser.id,
        email: createdUser.email,
      });
      return c.json(
        { error: "Failed to create user" },
        httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
      );
    }

    return c.json(
      { success: "User created successfully", user: { id: createdUser.id } },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to create user", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getDoctorsByDepartmentId = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }

    const departmentIdRaw = c.req.param("departmentId");
    const departmentId = Number.parseInt(departmentIdRaw, 10);
    if (!Number.isFinite(departmentId) || departmentId <= 0) {
      return c.json(
        { error: "Invalid departmentId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const clinic = await db.clinic.findUnique({
      where: { id: authUser.clinicId },
    });
    if (!clinic) {
      return c.json(
        { error: "Clinic not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const doctors = await db.user.findMany({
      where: {
        role: Role.DOCTOR,
        clinicId: clinic.id,
        clinicalDepartments: {
          some: { id: departmentId },
        },
      },
      select: {
        id: true,
        name: true,
      },
    });

    return c.json({ data: doctors }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    logger.error("Failed to fetch doctors by department", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const editUser = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    if (authUser.role !== "CLINIC_ADMIN") {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    const userIdRaw = c.req.param("userId");
    const userId = Number.parseInt(userIdRaw, 10);
    if (!Number.isFinite(userId) || userId <= 0) {
      return c.json(
        { error: "Invalid userId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const body = await c.get("validatedJson");
    const parsed = updateUserSchema.safeParse(body);
    if (!parsed.success) {
      return Promise.reject(
        new AppError({
          status: httpCodes.BAD_REQUEST,
          code: "INVALID_REQUEST",
          message: "Invalid request",
          exposeMessage: true,
          issues: Object.entries(parsed.error.flatten().fieldErrors).map(
            ([field, errors]) => ({
              field,
              message: errors.join(", "),
            })
          ),
        })
      );
    }

    const { email, name, role, phone_number, password } = parsed.data;

    const existingUser = await db.user.findUnique({ where: { id: userId } });
    if (!existingUser) {
      return c.json(
        { error: "User not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (existingUser.clinicId !== authUser.clinicId) {
      return c.json(
        { error: "You are not authorized to edit this user" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const updateData: Prisma.UserUpdateInput = {
      name,
      email,
      role: role as Role,
      phone_number,
    };

    await db.$transaction(async (tx) => {
      if (password) {
        const hashedPassword = hashCredentialPassword(password);
        updateData.password = hashedPassword;
        // Also update Better-Auth account password
        await tx.account.updateMany({
          where: { userId, providerId: "credential" },
          data: { password: hashedPassword },
        });
      }

      await tx.user.update({
        where: { id: userId },
        data: updateData,
      });
    });

    return c.json(
      { success: "User updated successfully" },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to update user", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const deactivateUser = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    if (authUser.role !== "CLINIC_ADMIN") {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const userIdRaw = c.req.param("userId");
    const userId = Number.parseInt(userIdRaw, 10);
    if (!Number.isFinite(userId) || userId <= 0) {
      return c.json(
        { error: "Invalid userId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const targetUser = await db.user.findUnique({ where: { id: userId } });
    if (!targetUser) {
      return c.json(
        { error: "User not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (targetUser.clinicId !== authUser.clinicId) {
      return c.json(
        { error: "You are not authorized to perform this action" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    await db.user.update({
      where: { id: userId },
      data: { status: UserStatus.INACTIVE },
    });

    return c.json(
      { success: "User deactivated successfully" },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to deactivate user", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getClinicDoctors = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    if (authUser.role !== "CLINIC_ADMIN" && authUser.role !== "DOCTOR") {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const params = searchParamsSchema.parse(c.req.query());
    const includeWeeklyTimesheet = truthyQueryValue(
      params.includeWeeklyTimesheet
    );
    const weekStartDate = includeWeeklyTimesheet
      ? resolveWeekStartDate(params.weekStart)
      : undefined;

    const queryOptions = buildQueryOptions<User>(params);
    const { where, orderBy, ...restOptions } = queryOptions;

    const doctorWhere: Prisma.UserWhereInput = {
      ...(where as Prisma.UserWhereInput),
      clinicId: authUser.clinicId,
      role: {
        in: [Role.DOCTOR, Role.NURSE],
      },
    };

    const doctors = await db.user.findMany({
      ...restOptions,
      where: doctorWhere,
      orderBy: orderBy as Prisma.UserOrderByWithRelationInput,
      include: {
        clinicalDepartments: {
          select: { id: true, name: true },
        },
        _count: {
          select: {
            doctorEvents: true,
            doctorVisits: true,
          },
        },
      },
    });

    const doctorIds = doctors.map((doctor) => doctor.id);
    const doctorsWithNonExpiredTimesheet =
      await buildNonExpiredTimesheetSet(doctorIds);
    const weeklyTimesheetByUserId = includeWeeklyTimesheet
      ? await buildWeeklyTimesheetMapForUsers(doctorIds, weekStartDate)
      : {};

    // Add hasNonExpiredTimesheet field (and weeklyTimesheet if requested) to each doctor
    const doctorsWithTimesheetFlag = doctors.map((doctor) => {
      const base = {
        ...doctor,
        hasNonExpiredTimesheet: doctorsWithNonExpiredTimesheet.has(doctor.id),
      };
      if (includeWeeklyTimesheet) {
        return {
          ...base,
          weeklyTimesheet: weeklyTimesheetByUserId[doctor.id] ?? [],
        };
      }
      return base;
    });

    const totalCount = await db.user.count({ where: doctorWhere });
    const take = restOptions.take ?? 0;
    const pageCount = take > 0 ? Math.ceil(totalCount / take) : 0;

    return c.json(
      {
        data: doctorsWithTimesheetFlag,
        totalCount,
        pageCount,
        ...(includeWeeklyTimesheet && weekStartDate
          ? { weekStart: weekStartDate.toISOString() }
          : {}),
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to list clinic doctors", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

//biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
export const createDoctor = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    if (authUser.role !== "CLINIC_ADMIN") {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const body = await c.get("validatedJson");
    const parsed = createDoctorSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const { weeklyAvailability, departments, ...doctorData } = parsed.data;

    const existing = await db.user.findUnique({
      where: { email: doctorData.email },
    });

    if (existing) {
      return c.json(
        { error: "User with this email already exists" },
        httpCodes.CONFLICT as ContentfulStatusCode
      );
    }

    const providedPassword =
      typeof doctorData.password === "string" && doctorData.password.length > 0;
    const rawPassword = providedPassword
      ? doctorData.password
      : generateTemporaryPassword();

    const appUrl = process.env.APP_URL ?? process.env.FRONTEND_URL;
    if (!appUrl) {
      throw new Error("app url is not configured");
    }

    const backendUrl = process.env.BACKEND_URL;
    if (!backendUrl) {
      throw new Error("BACKEND_URL is not configured");
    }

    const callbackURL = providedPassword
      ? `${appUrl}/auth/login?verified=1`
      : `${appUrl}/auth/set-password`;

    const signUpPayload: Record<string, unknown> = {
      email: doctorData.email,
      password: rawPassword,
      name: doctorData.name,
      role: doctorData.role,
      phone_number: doctorData.phone_number,
      clinicId: authUser.clinicId,
      branchId: authUser.branchId,
      callbackURL,
      highestEducation: doctorData.highestEducation,
      licenseNumber: doctorData.licenseNumber,
      license_document: doctorData.license_document,
      diploma_document: doctorData.diploma_document,
      licenseExpiration: formatLicenseExpiration(doctorData.licenseExpiration),
      consultationFee: doctorData.consultationFee,
    };

    const { response, data } = await signUpUserWithBetterAuth(
      backendUrl,
      appUrl,
      signUpPayload
    );

    if (
      !response.ok ||
      (data && typeof data === "object" && data !== null && "error" in data)
    ) {
      const message =
        (data as { error?: { message?: string } | string })?.error &&
        typeof (data as { error?: { message?: string } | string }).error ===
          "string"
          ? (data as { error?: string }).error
          : (data as { error?: { message?: string } })?.error?.message;
      return c.json(
        { error: message || "Failed to create doctor" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const newDoctor = await db.user.findUnique({
      where: { email: doctorData.email },
    });

    if (!newDoctor) {
      return c.json(
        { error: "Doctor created but could not be retrieved" },
        httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
      );
    }

    try {
      await db.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: newDoctor.id },
          data: {
            consultationFee: doctorData.consultationFee,
            licenseNumber: doctorData.licenseNumber,
            licenseExpiration: formatLicenseExpiration(
              doctorData.licenseExpiration
            ),
            license_document: doctorData.license_document,
            diploma_document: doctorData.diploma_document,
            highestEducation: doctorData.highestEducation as
              | EducationLevel
              | undefined,
            clinicalDepartments: {
              connect: departments.map((departmentId) => ({
                id: departmentId,
              })),
            },
          },
        });

        const availabilityData = filterValidAvailability(
          weeklyAvailability
        ).map((slot) => ({
          doctorId: newDoctor.id,
          startDayOfWeek: slot.startDayOfWeek,
          startTime: slot.startTime,
          endDayOfWeek: slot.endDayOfWeek,
          endTime: slot.endTime,
        }));

        if (availabilityData.length > 0) {
          await tx.doctorAvailability.createMany({ data: availabilityData });
        }
      });
    } catch (error) {
      await cleanupFailedStaffUser(
        newDoctor.id,
        newDoctor.email,
        "createDoctor"
      );
      logger.error("Failed to enrich created doctor", {
        error,
        userId: newDoctor.id,
        email: newDoctor.email,
      });
      return c.json(
        { error: "Failed to create doctor" },
        httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
      );
    }

    return c.json(
      {
        success: "Doctor created successfully",
        doctor: {
          id: newDoctor.id,
          name: newDoctor.name,
          email: newDoctor.email,
        },
      },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to create doctor", { error });
    return c.json(
      { error: "Failed to create doctor" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const addDoctorAvailability = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    const doctorIdRaw = c.req.param("id");
    const doctorId = Number.parseInt(doctorIdRaw, 10);

    if (!Number.isFinite(doctorId) || doctorId <= 0) {
      return c.json(
        { error: "Invalid doctorId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    if (authUser.role !== "CLINIC_ADMIN") {
      if (authUser.role === "DOCTOR" && authUser.id !== doctorId) {
        return c.json(
          { error: "Forbidden" },
          httpCodes.FORBIDDEN as ContentfulStatusCode
        );
      }
      if (authUser.role !== "DOCTOR") {
        return c.json(
          { error: "Forbidden" },
          httpCodes.FORBIDDEN as ContentfulStatusCode
        );
      }
    }

    if (!authUser.clinicId) {
      return c.json(
        { error: "Clinic not assigned" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    const doctor = await db.user.findUnique({
      where: { id: doctorId },
      select: { id: true, clinicId: true, role: true },
    });
    if (!doctor) {
      return c.json(
        { error: "Doctor not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (doctor.clinicId !== authUser.clinicId) {
      return c.json(
        { error: "You are not authorized to add availability for this doctor" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    if (doctor.role !== Role.DOCTOR) {
      return c.json(
        { error: "User is not a doctor" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const body = await c.get("validatedJson");
    const valid = filterValidAvailability(body.weeklyAvailability).map(
      (slot) => ({
        doctorId: doctor.id,
        startDayOfWeek: slot.startDayOfWeek,
        startTime: slot.startTime,
        endDayOfWeek: slot.endDayOfWeek,
        endTime: slot.endTime,
      })
    );
    if (valid.length === 0) {
      return c.json(
        { error: "Invalid weekly availability" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const created = await db.doctorAvailability.createMany({ data: valid });
    return c.json(
      { success: "Doctor availability added successfully", created },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to add doctor availability", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const assignDepartmentsToDoctor = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    const doctorIdRaw = c.req.param("id");
    const doctorId = Number.parseInt(doctorIdRaw, 10);

    if (!Number.isFinite(doctorId) || doctorId <= 0) {
      return c.json(
        { error: "Invalid doctorId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    if (authUser.role !== "CLINIC_ADMIN") {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    if (!authUser.clinicId) {
      return c.json(
        { error: "Clinic not assigned" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    const doctor = await db.user.findUnique({
      where: { id: doctorId },
      select: { id: true, clinicId: true, role: true },
    });
    if (!doctor) {
      return c.json(
        { error: "Doctor not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (doctor.clinicId !== authUser.clinicId) {
      return c.json(
        {
          error: "You are not authorized to assign departments to this doctor",
        },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    if (doctor.role !== Role.DOCTOR) {
      return c.json(
        { error: "User is not a doctor" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const body = await c.get("validatedJson");

    const validDepartments = await db.clinicalDepartment.findMany({
      where: {
        id: { in: body.departments },
        // clinics: { some: { id: authUser.clinicId } },
      },
      select: { id: true },
    });

    if (validDepartments.length !== body.departments.length) {
      return c.json(
        { error: "Invalid departments" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const updated = await db.user.update({
      where: { id: doctor.id },
      data: {
        clinicalDepartments: {
          connect: validDepartments.map((department) => ({
            id: department.id,
          })),
        },
      },
    });
    return c.json(
      { success: "Departments assigned to doctor successfully", updated },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to assign departments to doctor", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getAllClinicDoctors = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }

    const doctors = await db.user.findMany({
      where: {
        role: Role.DOCTOR,
        clinicId: authUser.clinicId,
      },
      select: {
        id: true,
        name: true,
      },
    });

    return c.json({ data: doctors }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    logger.error("Failed to fetch clinic doctors", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getAllBranchDoctors = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }

    const doctors = await db.user.findMany({
      where: {
        role: Role.DOCTOR,
        branchId: authUser.branchId,
      },
      select: {
        id: true,
        name: true,
      },
    });

    return c.json({ data: doctors }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    logger.error("Failed to fetch branch doctors", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getClinicNurses = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    const nurses = await db.user.findMany({
      where: {
        role: Role.NURSE,
        clinicId: authUser.clinicId,
        branchId: authUser.branchId,
        status: UserStatus.ACTIVE,
      },
      select: { id: true, name: true },
    });
    return c.json({ data: nurses }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const editDoctor = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    if (authUser.role !== "CLINIC_ADMIN") {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const doctorIdRaw = c.req.param("doctorId");
    const doctorId = Number.parseInt(doctorIdRaw, 10);
    if (!Number.isFinite(doctorId) || doctorId <= 0) {
      return c.json(
        { error: "Invalid doctorId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const body = await c.get("validatedJson");
    const parsed = editDoctorSchema.safeParse(body);
    if (!parsed.success) {
      return Promise.reject(
        new AppError({
          status: httpCodes.BAD_REQUEST,
          code: "INVALID_REQUEST",
          message: "Invalid request",
          exposeMessage: true,
          issues: Object.entries(parsed.error.flatten().fieldErrors).map(
            ([field, errors]) => ({
              field,
              message: errors.join(", "),
            })
          ),
        })
      );
    }

    const { weeklyAvailability, departments, password, ...doctorData } =
      parsed.data;

    const existingDoctor = await db.user.findUnique({
      where: { id: doctorId },
    });
    if (!existingDoctor) {
      return c.json(
        { error: "Doctor not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (existingDoctor.clinicId !== authUser.clinicId) {
      return c.json(
        { error: "You are not authorized to edit this doctor" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const updateData: Prisma.UserUpdateInput = {
      name: doctorData.name,
      email: doctorData.email,
      role: doctorData.role as Role,
      phone_number: doctorData.phone_number,
      consultationFee: doctorData.consultationFee,
      licenseNumber: doctorData.licenseNumber,
      licenseExpiration: formatLicenseExpiration(doctorData.licenseExpiration),
      license_document: doctorData.license_document,
      diploma_document: doctorData.diploma_document,
      highestEducation: doctorData.highestEducation as
        | EducationLevel
        | undefined,
      clinicalDepartments: {
        set: departments?.map((departmentId) => ({ id: departmentId })),
      },
    };

    // Only update availability if it's provided
    if (weeklyAvailability !== undefined) {
      const availabilityData = filterValidAvailability(weeklyAvailability).map(
        (slot) => ({
          startDayOfWeek: slot.startDayOfWeek,
          startTime: slot.startTime,
          endDayOfWeek: slot.endDayOfWeek,
          endTime: slot.endTime,
        })
      );

      updateData.doctorAvailabilities = {
        deleteMany: {},
        createMany: {
          data: availabilityData,
        },
      };
    }

    await db.$transaction(async (tx) => {
      if (password) {
        const hashedPassword = hashCredentialPassword(password);
        updateData.password = hashedPassword;
        // Also update Better-Auth account password
        await tx.account.updateMany({
          where: { userId: doctorId, providerId: "credential" },
          data: { password: hashedPassword },
        });
      }

      await tx.user.update({
        where: { id: doctorId },
        data: updateData,
      });
    });

    return c.json(
      {
        success: "Doctor updated successfully",
        doctor: { id: existingDoctor.id, email: existingDoctor.email },
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to update doctor", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getCashiers = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }

    const cashiers = await db.user.findMany({
      where: {
        role: Role.CASHIER,
        clinicId: authUser.clinicId,
      },
      select: {
        id: true,
        name: true,
      },
    });

    return c.json({ data: cashiers }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    logger.error("Failed to fetch cashiers", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getAvailableDoctorsByDepartmentId = async (c: Context) => {
  try {
    const user = c.get("user") as AuthenticatedUser | undefined;
    const { departmentId, date, includeDoctorId } = c.get("validatedJson");
    const clinic = await db.clinic.findUnique({
      where: { id: Number(user?.clinicId) },
    });
    if (!clinic) {
      return c.json(
        { error: "Clinic not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    // Fetch doctors in department
    const doctors = await db.user.findMany({
      where: {
        role: Role.DOCTOR,
        clinicId: clinic.id,
        clinicalDepartments: { some: { id: departmentId } },
        status: UserStatus.ACTIVE,
      },
      select: {
        id: true,
        name: true,
      },
    });

    if (doctors.length === 0) {
      return c.json({ data: [] }, httpCodes.OK as ContentfulStatusCode);
    }

    // Resolve the target date/time (fallback to "now" if invalid)
    const targetDate: Date = resolveTargetDate(date);

    // Build effective weekly timesheets for the week containing the target date
    const weekStart = startOfDay(startOfWeek(targetDate, { weekStartsOn: 1 }));
    const doctorIds = doctors.map((d) => d.id);
    const weeklyTimesheetByUserId = await buildWeeklyTimesheetMapForUsers(
      doctorIds,
      weekStart
    );

    const availableDoctors: { id: number; name: string }[] = [];

    for (const doc of doctors) {
      const weekly = weeklyTimesheetByUserId[doc.id] as
        | Array<{
            dayOfWeek: number;
            windows: Array<{
              start: string;
              end: string;
              crossesMidnight: boolean;
            }>;
          }>
        | undefined;
      const isWorkingNow = isWorkingNowForWeekly(weekly, targetDate);

      if (isWorkingNow) {
        availableDoctors.push({ id: doc.id, name: doc.name });
      }
    }

    // Ensure included doctor is present (for edit screens)
    if (
      includeDoctorId &&
      !availableDoctors.some((d) => d.id === includeDoctorId)
    ) {
      const extra = await db.user.findFirst({
        where: {
          id: includeDoctorId,
          clinicId: clinic.id,
          role: Role.DOCTOR,
        },
        select: { id: true, name: true },
      });
      if (extra) {
        availableDoctors.push(extra);
      }
    }

    return c.json(
      { data: availableDoctors },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to fetch available doctors by department", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getUserById = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    const userIdRaw = c.req.param("userId");
    const userId = Number.parseInt(userIdRaw, 10);
    if (!Number.isFinite(userId) || userId <= 0) {
      return c.json(
        { error: "Invalid userId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const user = await db.user.findUnique({
      where: { id: userId },
      include: userProfileInclude,
    });
    if (!user) {
      return jsonError(c, {
        status: httpCodes.NOT_FOUND,
        code: "NOT_FOUND",
        messageKey: "users.userNotFound",
      });
    }
    return c.json({ data: user }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    logger.error("Failed to get user by id", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getCurrentUser = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }

    const authUserId = Number.parseInt(String(authUser.id), 10);
    if (!Number.isFinite(authUserId) || authUserId <= 0) {
      return c.json(
        { error: "Invalid user id in session" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }

    const user = await db.user.findUnique({
      where: { id: authUserId },
      include: userProfileInclude,
    });

    if (!user) {
      return jsonError(c, {
        status: httpCodes.NOT_FOUND,
        code: "NOT_FOUND",
        messageKey: "users.userNotFound",
      });
    }

    return c.json({ data: user }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    logger.error("Failed to get current user", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updateMyLocalePreference = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return jsonError(c, {
        status: httpCodes.UNAUTHORIZED,
        code: "UNAUTHORIZED",
        messageKey: "common.unauthorized",
      });
    }

    const body = c.get("validatedJson") as { preferredLocale: "en" | "fr" };
    const updatedUser = await db.user.update({
      where: { id: authUser.id },
      data: {
        preferredLocale: body.preferredLocale,
      },
      select: {
        id: true,
        preferredLocale: true,
      },
    });

    return jsonSuccess(c, {
      status: httpCodes.OK,
      messageKey: "users.preferencesUpdated",
      data: updatedUser,
    });
  } catch (error) {
    logger.error("Failed to update locale preference", { error });
    return jsonError(c, {
      status: httpCodes.INTERNAL_SERVER_ERROR,
      code: "INTERNAL_SERVER_ERROR",
      messageKey: "common.internalServerError",
    });
  }
};

export const getUserTimesheet = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    const userId = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(userId) || userId <= 0) {
      return c.json(
        { error: "Invalid userId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, clinicId: true },
    });
    if (!user || user.clinicId == null) {
      return c.json(
        { error: "User not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (authUser.clinicId !== user.clinicId) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    const timesheets = await db.staffTimesheet.findMany({
      where: { userId: user.id, isActive: true },
      include: { shifts: true, exceptions: true },
      orderBy: { createdAt: "desc" },
    });
    return c.json({ data: timesheets }, httpCodes.OK as ContentfulStatusCode);
  } catch (_error) {
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const upsertUserTimesheet = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }
    const userId = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(userId) || userId <= 0) {
      return c.json(
        { error: "Invalid userId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const payload = c.get("validatedJson") as UpsertTimesheetInput;
    const actorRole = authUser.role;
    if (actorRole !== "CLINIC_ADMIN" && actorRole !== "BRANCH_ADMIN") {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, clinicId: true },
    });
    if (!user || user.clinicId == null) {
      return c.json(
        { error: "User not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    const userClinicId = user.clinicId;
    if (authUser.clinicId !== userClinicId) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const branchIds = Array.from(
      new Set(
        (payload.shifts ?? [])
          .map((s) => s.branchId)
          .filter((b): b is number => typeof b === "number")
      )
    );
    if (branchIds.length > 0) {
      const validBranches = await db.branch.findMany({
        where: { id: { in: branchIds }, clinicId: userClinicId },
        select: { id: true },
      });
      if (validBranches.length !== branchIds.length) {
        return c.json(
          { error: "Invalid branchId in shifts" },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
      }
    }

    // Dates are validated as Date objects by zod - assert types for Prisma
    const startDate = payload.startDate as Date;
    const endDate = payload.endDate as Date;

    const created = await db.$transaction(async (tx) => {
      const newTimesheetIsActive = payload.isActive ?? true;
      if (newTimesheetIsActive) {
        await tx.staffTimesheet.updateMany({
          where: {
            userId: user.id,
            periodType: payload.periodType as TimesheetPeriod,
            isActive: true,
            OR: [
              {
                startDate: { lte: endDate },
                endDate: { gte: startDate },
              },
            ],
          },
          data: { isActive: false },
        });
      }
      const ts = await tx.staffTimesheet.create({
        data: {
          userId: user.id,
          clinicId: userClinicId,
          periodType: payload.periodType as TimesheetPeriod,
          startDate,
          endDate,
          isActive: newTimesheetIsActive,
        },
      });
      if (payload.shifts?.length) {
        await tx.staffShift.createMany({
          data: payload.shifts.map((s) => ({
            timesheetId: ts.id,
            daysOfWeek: s.daysOfWeek,
            startTime: s.startTime,
            endTime: s.endTime,
            branchId: s.branchId ?? null,
          })),
        });
      }
      if (payload.exceptions?.length) {
        await tx.staffScheduleException.createMany({
          data: payload.exceptions.map((e) => ({
            timesheetId: ts.id,
            date: e.date,
            isWorking: e.isWorking ?? false,
            startTime: e.startTime ?? null,
            endTime: e.endTime ?? null,
            branchId: e.branchId ?? null,
          })),
        });
      }
      return ts;
    });

    await logActivity({
      userId: Number(authUser.id),
      action: `Updated timesheet for user ${user.id}`,
      type: ActivityType.STATUS_UPDATE,
    });
    // Invalidate any cached availability for this user
    await invalidateCache(
      `${CACHE_KEYS.APPOINTMENTS.DOCTOR_AVAILABILITY}:${user.id}:*`
    );

    return c.json(
      { success: true, timesheetId: created.id },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

const calculateTimesheetStatus = (
  endDate: Date,
  todayStart: Date,
  twoDaysFromNow: Date
): {
  status: "ACTIVE" | "EXPIRING_SOON" | "EXPIRED";
  daysUntilExpiry: number;
} => {
  const endDateStart = startOfDay(endDate);
  const daysUntilExpiry = Math.floor(
    (endDateStart.getTime() - todayStart.getTime()) / (1000 * 60 * 60 * 24)
  );

  let status: "ACTIVE" | "EXPIRING_SOON" | "EXPIRED";
  if (endDateStart.getTime() < todayStart.getTime()) {
    status = "EXPIRED";
  } else if (
    endDateStart.getTime() <= twoDaysFromNow.getTime() &&
    endDateStart.getTime() >= todayStart.getTime()
  ) {
    status = "EXPIRING_SOON";
  } else {
    status = "ACTIVE";
  }

  return { status, daysUntilExpiry };
};

const buildDateRangeFilter = (
  from?: string,
  to?: string
): Prisma.DateTimeFilter | null => {
  const fromDate = from ? parseISO(from) : null;
  const toDate = to ? parseISO(to) : null;

  if (fromDate === null && toDate === null) {
    return null;
  }

  const filter: Prisma.DateTimeFilter = {};
  if (fromDate) {
    filter.gte = startOfDay(fromDate);
  }
  if (toDate) {
    filter.lte = endOfDay(toDate);
  }
  return filter;
};

const buildStatusWhereConditions = (
  statusArray: string[],
  todayStart: Date,
  twoDaysFromNow: Date
): Prisma.StaffTimesheetWhereInput[] => {
  const hasExpired = statusArray.includes("EXPIRED");
  const hasExpiringSoon = statusArray.includes("EXPIRING_SOON");
  const hasActive = statusArray.includes("ACTIVE");

  const selectedCount =
    Number(hasExpired) + Number(hasExpiringSoon) + Number(hasActive);
  const allStatusesSelected = selectedCount === 3;
  const noStatusesSelected = selectedCount === 0;

  // If all statuses are requested or none specified, return empty array (no filter)
  if (allStatusesSelected || noStatusesSelected) {
    return [];
  }

  const conditions: Prisma.StaffTimesheetWhereInput[] = [];

  if (hasExpired) {
    conditions.push({ endDate: { lt: todayStart } });
  }

  if (hasExpiringSoon) {
    conditions.push({
      endDate: {
        gte: todayStart,
        lte: twoDaysFromNow,
      },
    });
  }

  if (hasActive) {
    conditions.push({ endDate: { gt: twoDaysFromNow } });
  }

  return conditions;
};

type TimesheetFilterContext = {
  todayStart: Date;
  twoDaysFromNow: Date;
};

const buildTimesheetWhereConditions = (
  params: ReturnType<typeof searchParamsSchema.parse>,
  clinicId: number,
  baseWhere: Record<string, unknown>,
  context: TimesheetFilterContext
): Prisma.StaffTimesheetWhereInput => {
  const timesheetWhere: Prisma.StaffTimesheetWhereInput = {
    clinicId,
    isActive: true,
    ...(baseWhere as Prisma.StaffTimesheetWhereInput),
  };

  if (params.name) {
    timesheetWhere.user = {
      name: { contains: params.name, mode: "insensitive" },
    };
  }

  if (params.type) {
    const periodTypes = params.type.split(".");
    timesheetWhere.periodType = {
      in: periodTypes as TimesheetPeriod[],
    };
  }

  // Handle status filtering by translating to date ranges
  if (params.status) {
    const statusArray = params.status.split(".");
    const statusConditions = buildStatusWhereConditions(
      statusArray,
      context.todayStart,
      context.twoDaysFromNow
    );

    if (statusConditions.length > 0) {
      // If we have status conditions, use OR to combine them
      if (statusConditions.length === 1) {
        Object.assign(timesheetWhere, statusConditions[0]);
      } else {
        // Multiple status conditions need OR
        // Prisma will AND root conditions (clinicId, isActive) with OR conditions
        timesheetWhere.OR = statusConditions;
      }
    }
  }

  // Handle explicit date range filtering (from/to params)
  // This takes precedence if both status and date range are provided
  const dateRangeFilter = buildDateRangeFilter(params.from, params.to);
  if (dateRangeFilter !== null) {
    timesheetWhere.endDate = dateRangeFilter;
  }

  return timesheetWhere;
};

export const getExpiringTimesheetsCount = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }

    const actorRole = authUser.role;
    if (actorRole !== "CLINIC_ADMIN" && actorRole !== "BRANCH_ADMIN") {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    if (!authUser.clinicId) {
      return c.json(
        { error: "Clinic ID required" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const todayStart = startOfDay(new Date());
    const twoDaysFromNow = startOfDay(addDays(todayStart, 2));

    const count = await db.staffTimesheet.count({
      where: {
        clinicId: authUser.clinicId,
        isActive: true,
        endDate: {
          gte: todayStart,
          lte: twoDaysFromNow,
        },
      },
    });

    return c.json({ count }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getStaffWithoutTimesheets = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }

    const actorRole = authUser.role;
    if (actorRole !== "CLINIC_ADMIN" && actorRole !== "BRANCH_ADMIN") {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    if (!authUser.clinicId) {
      return c.json(
        { error: "Clinic ID required" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    // Get all staff (excluding admins)
    const allStaff = await db.user.findMany({
      where: {
        clinicId: authUser.clinicId,
        ...(actorRole === "BRANCH_ADMIN"
          ? { user: { branchId: authUser.branchId } }
          : {}),
        role: {
          notIn: [Role.SUPER_ADMIN, Role.CLINIC_ADMIN],
        },
        status: UserStatus.ACTIVE,
      },
      select: {
        id: true,
        name: true,
        role: true,
      },
    });

    // Get all active timesheets to find which staff already have them
    const timesheets = await db.staffTimesheet.findMany({
      where: {
        clinicId: authUser.clinicId,
        ...(actorRole === "BRANCH_ADMIN"
          ? { branchId: authUser.branchId }
          : {}),
        isActive: true,
      },
      select: {
        userId: true,
      },
    });

    // Create a set of user IDs that have timesheets
    const staffWithTimesheets = new Set(
      timesheets.map((timesheet) => timesheet.userId)
    );

    // Filter out staff who already have timesheets
    const staffWithoutTimesheets = allStaff.filter(
      (staff) => !staffWithTimesheets.has(staff.id)
    );

    return c.json(
      { data: staffWithoutTimesheets },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to fetch staff without timesheets", { error });
    return c.json(
      { error: "Internal server error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getClinicTimesheets = async (c: Context) => {
  try {
    const authUser = c.get("user") as AuthenticatedUser | undefined;
    if (!authUser) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.UNAUTHORIZED as ContentfulStatusCode
      );
    }

    const actorRole = authUser.role;
    if (actorRole !== "CLINIC_ADMIN" && actorRole !== "BRANCH_ADMIN") {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    if (!authUser.clinicId) {
      return c.json(
        { error: "Clinic ID required" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const params = searchParamsSchema.parse(c.req.query());
    const queryOptions = buildQueryOptions<StaffTimesheet>(params);
    const { where, orderBy, ...restOptions } = queryOptions;

    const todayStart = startOfDay(new Date());
    const twoDaysFromNow = startOfDay(addDays(todayStart, 2));

    const timesheetWhere = buildTimesheetWhereConditions(
      params,
      authUser.clinicId,
      where,
      { todayStart, twoDaysFromNow }
    );

    const [timesheets, totalCount] = await Promise.all([
      db.staffTimesheet.findMany({
        ...restOptions,
        where: timesheetWhere,
        orderBy: orderBy as Prisma.StaffTimesheetOrderByWithRelationInput,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              role: true,
            },
          },
          shifts: true,
          exceptions: true,
        },
      }),
      db.staffTimesheet.count({ where: timesheetWhere }),
    ]);

    // Calculate status for display (all records already match the status filter)
    const timesheetsWithStatus = timesheets.map((ts) => {
      const { status, daysUntilExpiry } = calculateTimesheetStatus(
        ts.endDate,
        todayStart,
        twoDaysFromNow
      );
      return {
        ...ts,
        status,
        daysUntilExpiry,
      };
    });

    const take = restOptions.take ?? 0;
    const pageCount = take > 0 ? Math.ceil(totalCount / take) : 0;

    return c.json(
      {
        data: timesheetsWithStatus,
        totalCount,
        pageCount,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
