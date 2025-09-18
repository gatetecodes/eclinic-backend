import { hash } from "bcryptjs";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  type Clinic,
  type Prisma,
  Role,
  UserStatus,
} from "../../../../generated/prisma";
import { db } from "../../../database/db";
import { buildQueryOptions } from "../../../helpers/query-helper";
import { searchParamsSchema } from "../../../lib/common-validation";
import { httpCodes } from "../../../lib/constants";
import { clinicSchema } from "./clinics.validation";

export const getClinics = async (c: Context) => {
  try {
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
        error: validatedFields.error,
        status: httpCodes.BAD_REQUEST,
      });
    }
    const clinic = await db.$transaction(async (tx) => {
      const { admin, ...clinicData } = validatedFields.data;
      const newClinic = await tx.clinic.create({ data: clinicData });
      const branch = await tx.branch.create({
        data: { name: "Main Branch", code: "MAIN", clinicId: newClinic.id },
      });
      const hashedPassword = await hash(
        process.env.DEFAULT_USER_PASSWORD as string,
        10
      );
      const adminUser = await tx.user.create({
        data: {
          ...admin,
          branchId: branch.id,
          clinicId: newClinic.id,
          role: Role.CLINIC_ADMIN,
          status: UserStatus.ACTIVE,
          password: hashedPassword,
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
