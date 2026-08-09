import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  type Clinic,
  type Prisma,
  Role,
  SubscriptionStatus,
  UserStatus,
} from "../../../../generated/prisma/client";
import { db } from "../../../database/db";
import { hashCredentialPassword } from "../../../helpers/auth-helper";
import { buildQueryOptions } from "../../../helpers/query-helper";
import { defaultFlowConfigRows } from "../../../lib/clinic-flow";
import { searchParamsSchema } from "../../../lib/common-validation";
import { httpCodes } from "../../../lib/constants";
import { logger } from "../../../lib/logger";
import { writeAudit } from "../../../services/audit.service";
import { invalidateEntitlements } from "../../../services/entitlements.service";
import { createVerificationEmail } from "../users/users.controller";
import { clinicSchema } from "./clinics.validation";

export const getClinics = async (c: Context) => {
  try {
    const user = c.get("user");
    if (user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    const params = searchParamsSchema.parse(c.req.query());
    const queryOptions = buildQueryOptions<Clinic>(params);
    const { where, orderBy, ...restOptions } = queryOptions;
    // Archived clinics are soft-deleted: excluded from the operator listing
    // unless explicitly requested via ?includeArchived=true.
    const includeArchived = c.req.query("includeArchived") === "true";
    const scopedWhere = {
      ...where,
      ...(includeArchived ? {} : { archivedAt: null }),
    } as Prisma.ClinicWhereInput;
    const clinics = await db.clinic.findMany({
      where: scopedWhere,
      orderBy: orderBy as Prisma.ClinicOrderByWithRelationInput,
      ...restOptions,
    });
    const totalCount = await db.clinic.count({
      where: scopedWhere,
    });
    const pageCount = restOptions.take
      ? Math.ceil(totalCount / restOptions.take)
      : 0;
    return c.json(
      {
        success: "Clinics fetched successfully",
        data: clinics,
        totalCount,
        pageCount,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const createClinic = async (c: Context) => {
  try {
    const validatedFields = clinicSchema.safeParse(await c.req.json());
    if (!validatedFields.success) {
      return c.json({
        error: validatedFields.error.flatten().fieldErrors,
        status: httpCodes.BAD_REQUEST,
      });
    }
    const user = c.get("user");

    if (user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    const clinic = await db.$transaction(async (tx) => {
      const { admin, operatingCountry, ...clinicData } = validatedFields.data;
      const newClinic = await tx.clinic.create({
        data: {
          ...clinicData,
          operatingCountry: operatingCountry.toUpperCase(),
        },
      });
      const branch = await tx.branch.create({
        data: {
          name: "Main Branch",
          code: "MAIN",
          clinicId: newClinic.id,
          isHeadOffice: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      // Seed the default care-flow config (all stages enabled, canonical order)
      // so the clinic starts with the standard pipeline and the admin can toggle
      // optional stages from day one.
      await tx.clinicFlowConfig.createMany({
        data: defaultFlowConfigRows(newClinic.id),
      });
      const adminUser = await tx.user.create({
        data: {
          name: admin.name,
          email: admin.email,
          phone_number: admin.phone_number,
          branchId: branch.id,
          clinicId: newClinic.id,
          role: Role.CLINIC_ADMIN,
          status: UserStatus.ACTIVE,
          emailVerified: null, // Explicitly set to avoid coercion issues
        },
      });

      // Create better-auth credential account for the admin user
      const credentialHash = hashCredentialPassword(
        process.env.DEFAULT_USER_PASSWORD as string
      );
      await tx.account.create({
        data: {
          providerId: "credential",
          accountId: adminUser.id.toString(),
          userId: adminUser.id,
          password: credentialHash,
        },
      });
      return { newClinic, branch, adminUser };
    });

    // Send verification email to the clinic admin so they can activate their account
    const emailResult = await createVerificationEmail(clinic.adminUser.email, {
      locale: c.get("locale"),
    });
    if (!emailResult.success) {
      logger.warn("Clinic admin created but verification email failed", {
        email: clinic.adminUser.email,
        error: emailResult.error,
      });
    }

    await writeAudit(c, "clinic.created", {
      targetType: "clinic",
      targetId: clinic.newClinic.id,
      metadata: { name: clinic.newClinic.name },
    });

    const responseBody: {
      success: string;
      data: typeof clinic;
      message?: string;
    } = {
      success: "Clinic created successfully",
      data: clinic,
    };

    if (!emailResult.success) {
      responseBody.message =
        "Clinic created successfully, but we couldn't send the verification email. Please contact support if you don't receive an email.";
    }

    return c.json(responseBody, httpCodes.CREATED as ContentfulStatusCode);
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getClinicById = async (c: Context) => {
  try {
    const { id } = c.req.param();
    const clinicId = Number.parseInt(id, 10);
    // This response embeds branches + all users of the clinic. Restrict it to
    // the SaaS operator or a member of that same clinic — previously it had no
    // role check, so any authenticated user could read any tenant's roster.
    const user = c.get("user");
    if (user.role !== Role.SUPER_ADMIN && user.clinicId !== clinicId) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    const clinic = await db.clinic.findUnique({
      where: { id: clinicId },
      include: {
        branches: true,
        users: true,
        _count: { select: { patients: true, visits: true } },
      },
    });
    if (!clinic) {
      return c.json(
        { error: "Clinic not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    return c.json(
      { success: true, data: clinic },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updateClinic = async (c: Context) => {
  try {
    const user = c.get("user");
    if (user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    const { id } = c.req.param();
    const clinicId = Number.parseInt(id, 10);
    const data = c.get("validatedJson");
    const normalizedData = {
      ...data,
      ...(typeof data.operatingCountry === "string"
        ? { operatingCountry: data.operatingCountry.toUpperCase() }
        : {}),
    };
    const updatedClinic = await db.clinic.update({
      where: { id: clinicId },
      data: normalizedData,
    });

    // Invalidate entitlements if subscription plan, status or expiry date is updated
    if (
      "subscriptionPlan" in normalizedData ||
      "subscriptionStatus" in normalizedData ||
      "subscriptionExpiryDate" in normalizedData
    ) {
      await invalidateEntitlements(clinicId);
    }
    await writeAudit(c, "clinic.updated", {
      targetType: "clinic",
      targetId: clinicId,
      metadata: { fields: Object.keys(normalizedData) },
    });
    return c.json(
      {
        success: "Clinic updated successfully",
        data: updatedClinic,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updateClinicAdmin = async (c: Context) => {
  try {
    const user = c.get("user");
    if (user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    const { id } = c.req.param();
    const clinicId = Number.parseInt(id, 10);
    const data = c.get("validatedJson");
    const clinicAdmin = await db.user.findFirst({
      where: { id: data.admin.id, clinicId },
    });
    if (!clinicAdmin) {
      return c.json(
        { error: "Clinic admin not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    const updatedClinicAdmin = await db.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: clinicAdmin.id },
        data,
      });

      if (data.admin.email) {
        await tx.account.updateMany({
          where: { userId: clinicAdmin.id },
          data: { accountId: data.admin.email },
        });

        // Send verification email for new admin email
        const emailResult = await createVerificationEmail(data.admin.email, {
          locale: c.get("locale"),
        });
        if (!emailResult.success) {
          logger.warn(
            "Clinic admin email updated but verification email failed",
            {
              email: data.admin.email,
              error: emailResult.error,
            }
          );
        }
      }

      return updated;
    });

    return c.json(
      {
        success: "Clinic admin updated successfully",
        data: updatedClinicAdmin,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updateClinicSubscriptionStatus = async (c: Context) => {
  try {
    const user = c.get("user");
    if (user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    const { id } = c.req.param();
    const clinicId = Number.parseInt(id, 10);
    const data = c.get("validatedJson");
    const updatedClinic = await db.clinic.update({
      where: { id: clinicId },
      data,
    });

    // Invalidate entitlements if subscription status is updated
    if ("subscriptionStatus" in data) {
      await invalidateEntitlements(clinicId);
    }
    await writeAudit(c, "clinic.subscriptionChanged", {
      targetType: "clinic",
      targetId: clinicId,
      metadata: { fields: Object.keys(data) },
    });
    return c.json(
      {
        success: "Clinic subscription status updated successfully",
        data: updatedClinic,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getPortalClinics = async (c: Context) => {
  try {
    const clinics = await db.clinic.findMany({
      where: { subscriptionStatus: SubscriptionStatus.ACTIVE },
      select: {
        id: true,
        name: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });
    return c.json(
      {
        success: "Portal clinics fetched successfully",
        data: clinics,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getPortalClinicDoctors = async (c: Context) => {
  try {
    const { id } = c.req.param();
    const clinicId = Number.parseInt(id, 10);
    if (Number.isNaN(clinicId)) {
      return c.json(
        { error: "Invalid clinicId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const clinic = await db.clinic.findUnique({
      where: { id: clinicId },
    });
    if (!clinic) {
      return c.json(
        { error: "Clinic not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (clinic.subscriptionStatus !== SubscriptionStatus.ACTIVE) {
      return c.json(
        { error: "Clinic is not active" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const doctors = await db.user.findMany({
      where: { clinicId, status: UserStatus.ACTIVE, role: Role.DOCTOR },
      select: {
        id: true,
        name: true,
      },
    });
    return c.json(
      {
        success: "Doctors fetched successfully",
        data: doctors,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const togglePatientPortalForClinic = async (c: Context) => {
  try {
    const { id } = c.req.param();
    const user = c.get("user");
    if (user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    const clinicId = Number.parseInt(id, 10);
    if (Number.isNaN(clinicId)) {
      return c.json(
        { error: "Invalid clinicId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const clinic = await db.clinic.findUnique({
      where: { id: clinicId },
    });
    if (!clinic) {
      return c.json(
        { error: "Clinic not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (clinic.subscriptionStatus !== SubscriptionStatus.ACTIVE) {
      return c.json(
        { error: "Clinic is not active" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    await db.clinic.update({
      where: { id: clinicId },
      data: { isPatientPortalEnabled: !clinic.isPatientPortalEnabled },
    });

    return c.json(
      {
        success: "Patient portal toggled successfully",
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updateClinicSettings = async (c: Context) => {
  try {
    const { id } = c.req.param();
    const user = c.get("user");
    const clinicId = Number.parseInt(id, 10);

    if (Number.isNaN(clinicId)) {
      return c.json(
        { error: "Invalid clinicId" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    if (user.role !== Role.SUPER_ADMIN && user.clinicId !== clinicId) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const body = c.get("validatedJson");
    const {
      isQueueManagementEnabled,
      defaultCurrency,
      isSmsEnabled,
      smsOnQueueJoined,
      smsOnQueueTurn,
      smsOnLabResultsReady,
      smsOnVisitCompletion,
    } = body;

    const clinic = await db.clinic.findUnique({
      where: { id: clinicId },
    });
    if (!clinic) {
      return c.json(
        { error: "Clinic not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const updatedClinic = await db.clinic.update({
      where: { id: clinicId },
      data: {
        isQueueManagementEnabled:
          typeof isQueueManagementEnabled === "boolean"
            ? isQueueManagementEnabled
            : undefined,
        defaultCurrency,
        isSmsEnabled:
          typeof isSmsEnabled === "boolean" ? isSmsEnabled : undefined,
        smsOnQueueJoined:
          typeof smsOnQueueJoined === "boolean" ? smsOnQueueJoined : undefined,
        smsOnQueueTurn:
          typeof smsOnQueueTurn === "boolean" ? smsOnQueueTurn : undefined,
        smsOnLabResultsReady:
          typeof smsOnLabResultsReady === "boolean"
            ? smsOnLabResultsReady
            : undefined,
        smsOnVisitCompletion:
          typeof smsOnVisitCompletion === "boolean"
            ? smsOnVisitCompletion
            : undefined,
      },
    });

    return c.json(
      {
        success: "Clinic settings updated successfully",
        data: updatedClinic,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
