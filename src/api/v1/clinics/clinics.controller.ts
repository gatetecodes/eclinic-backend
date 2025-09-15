import { type Context } from "hono";
import { db } from "../../../database/db";
import { buildQueryOptions } from "../../../helpers/query-helper";
import {
  type Clinic,
  type Prisma,
  Role,
  UserStatus,
} from "../../../../generated/prisma";
import { searchParamsSchema } from "../../../lib/common-validation";
import { httpCodes } from "../../../lib/constants";
import { clinicSchema } from "./clinics.validation";
import { hash } from "bcryptjs";

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
  } catch (error) {
    console.error("Get clinics error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};

export const createClinic = async (c: Context) => {
  try {
    const validatedFields = clinicSchema.safeParse(await c.req.json());
    if (!validatedFields.success)
      return c.json({
        error: validatedFields.error,
        status: httpCodes.BAD_REQUEST,
      });
    const clinic = await db.$transaction(async (tx) => {
      const { admin, ...clinicData } = validatedFields.data;
      const clinic = await tx.clinic.create({ data: clinicData });
      const branch = await tx.branch.create({
        data: { name: "Main Branch", code: "MAIN", clinicId: clinic.id },
      });
      const hashedPassword = await hash(
        process.env.DEFAULT_USER_PASSWORD as string,
        10,
      );
      const adminUser = await tx.user.create({
        data: {
          ...admin,
          branchId: branch.id,
          clinicId: clinic.id,
          role: Role.CLINIC_ADMIN,
          status: UserStatus.ACTIVE,
          password: hashedPassword,
        },
      });
      return { clinic, branch, adminUser };
    });
    return c.json({
      status: httpCodes.CREATED,
      message: "Clinic created successfully",
      data: clinic,
    });
  } catch (error) {
    console.error("Create clinic error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};

export const getClinicById = async (c: Context) => {
  try {
    const { id } = c.req.param();
    const clinic = await db.clinic.findUnique({
      where: { id: parseInt(id) },
      include: {
        branches: true,
        users: true,
        _count: { select: { patients: true, visits: true } },
      },
    });
    if (!clinic) return c.json({ error: "Clinic not found" }, 404);
    return c.json({ data: clinic });
  } catch (error) {
    console.error("Get clinic error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};
