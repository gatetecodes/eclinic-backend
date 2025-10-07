import { hash } from "bcryptjs";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  type Clinic,
  type Prisma,
  Role,
  SubscriptionStatus,
  UserStatus,
} from "../../../../generated/prisma";
import { db } from "../../../database/db";
import { buildQueryOptions } from "../../../helpers/query-helper";
import { searchParamsSchema } from "../../../lib/common-validation";
import { httpCodes } from "../../../lib/constants";
import { logger } from "../../../lib/logger";
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
    const clinics = await db.clinic.findMany({
      where: {
        ...where,
      } as Prisma.ClinicWhereInput,
      orderBy: orderBy as Prisma.ClinicOrderByWithRelationInput,
      ...restOptions,
    });
    const totalCount = await db.clinic.count({
      where: {
        ...where,
      } as Prisma.ClinicWhereInput,
    });
    const pageCount = restOptions.take
      ? Math.ceil(totalCount / restOptions.take)
      : 0;
    return c.json({
      status: httpCodes.OK,
      message: "Clinics fetched successfully",
      data: clinics,
      totalCount,
      pageCount,
    });
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
      const { admin, ...clinicData } = validatedFields.data;
      const newClinic = await tx.clinic.create({ data: clinicData });
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
      const hashedPassword = await hash(
        process.env.DEFAULT_USER_PASSWORD as string,
        10
      );
      const adminUser = await tx.user.create({
        data: {
          name: admin.name,
          email: admin.email,
          phone_number: admin.phone_number,
          branchId: branch.id,
          clinicId: newClinic.id,
          role: Role.CLINIC_ADMIN,
          status: UserStatus.ACTIVE,
          password: hashedPassword,
          emailVerified: null, // Explicitly set to avoid coercion issues
        },
      });
      return { newClinic, branch, adminUser };
    });
    return c.json({
      status: httpCodes.CREATED,
      message: "Clinic created successfully",
      data: clinic,
    });
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
    const clinic = await db.clinic.findUnique({
      where: { id: Number.parseInt(id, 10) },
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
    return c.json({ data: clinic });
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
    const updatedClinic = await db.clinic.update({
      where: { id: clinicId },
      data,
    });

    // Invalidate entitlements if subscription plan, status or expiry date is updated
    if (
      "subscriptionPlan" in data ||
      "subscriptionStatus" in data ||
      "subscriptionExpiryDate" in data
    ) {
      await invalidateEntitlements(clinicId);
    }
    return c.json({
      status: httpCodes.OK,
      message: "Clinic updated successfully",
      data: updatedClinic,
    });
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
    const updatedClinicAdmin = await db.user.update({
      where: { id: clinicAdmin.id },
      data,
    });

    if (data.admin.email) {
      await db.account.updateMany({
        where: { userId: clinicAdmin.id },
        data: { accountId: data.admin.email },
      });

      // Send verification email for new admin email
      const emailResult = await createVerificationEmail(data.admin.email);
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

    return c.json({
      status: httpCodes.OK,
      message: "Clinic admin updated successfully",
      data: updatedClinicAdmin,
    });
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
    return c.json({
      status: httpCodes.OK,
      message: "Clinic subscription status updated successfully",
      data: updatedClinic,
    });
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
    return c.json({
      status: httpCodes.OK,
      message: "Portal clinics fetched successfully",
      data: clinics,
    });
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
    return c.json({
      status: httpCodes.OK,
      message: "Doctors fetched successfully",
      data: doctors,
    });
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
    const updatedClinic = await db.clinic.update({
      where: { id: clinicId },
      data: { isPatientPortalEnabled: !clinic.isPatientPortalEnabled },
    });

    return c.json({
      status: httpCodes.OK,
      message: "Patient portal toggled successfully",
      data: updatedClinic,
    });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
