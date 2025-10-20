import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  CACHE_KEYS,
  DEFAULT_CACHE_TTL,
  getCachedData,
} from "@/services/redis.service";
import {
  type ClinicalDepartment,
  type Prisma,
  Role,
} from "../../../../generated/prisma";
import { db } from "../../../database/db";
import { buildQueryOptions } from "../../../helpers/query-helper";
import { searchParamsSchema } from "../../../lib/common-validation";
import { httpCodes } from "../../../lib/constants";
import {
  createClinicDepartmentsSchema,
  createDepartmentSchema,
  updateDepartmentSchema,
} from "./departments.validation";

export const getDepartments = async (c: Context) => {
  try {
    const user = c.get("user");
    if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const params = searchParamsSchema.parse(c.req.query());
    const queryOptions = buildQueryOptions<ClinicalDepartment>(params);
    const { where, orderBy, ...restOptions } = queryOptions;

    const departments = await db.clinicalDepartment.findMany({
      where: {
        ...where,
        clinics: {
          some: {
            id: user.role === Role.SUPER_ADMIN ? undefined : user.clinic.id,
          },
        },
      } as Prisma.ClinicalDepartmentWhereInput,
      orderBy: orderBy as Prisma.ClinicalDepartmentOrderByWithRelationInput,
      ...restOptions,
      include: {
        _count: {
          select: {
            users: true,
            visits: true,
            clinics: true,
          },
        },
      },
    });

    const totalCount = await db.clinicalDepartment.count({
      where: {
        ...where,
        clinics: {
          some: {
            id: user.role === Role.SUPER_ADMIN ? undefined : user.clinic.id,
          },
        },
      } as Prisma.ClinicalDepartmentWhereInput,
    });

    const pageCount = restOptions.take
      ? Math.ceil(totalCount / restOptions.take)
      : 0;

    return c.json({
      status: httpCodes.OK,
      message: "Departments fetched successfully",
      data: departments,
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

export const getAllClinicDepartments = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const cacheKey = `${CACHE_KEYS.DASHBOARD.DEPARTMENTS}:${user.clinicId}:${user.role}:${JSON.stringify(params || {})}`;
    const data = await getCachedData(
      cacheKey,
      async () => {
        const queryOptions = buildQueryOptions<ClinicalDepartment>(params);
        const { where, orderBy, ...restOptions } = queryOptions;
        const departments = await db.clinicalDepartment.findMany({
          where: {
            ...where,
            clinics: {
              some: {
                id: user.clinicId,
              },
            },
          } as Prisma.ClinicalDepartmentWhereInput,
          orderBy: orderBy as Prisma.ClinicalDepartmentOrderByWithRelationInput,
          ...restOptions,
        });
        const totalCount = await db.clinicalDepartment.count({
          where: {
            ...where,
            clinics: {
              some: { id: user.clinicId },
            },
          } as Prisma.ClinicalDepartmentWhereInput,
        });
        const pageCount = restOptions.take
          ? Math.ceil(totalCount / restOptions.take)
          : 0;
        return {
          data: departments,
          totalCount,
          pageCount,
        };
      },
      DEFAULT_CACHE_TTL.SHORT
    );
    return c.json({
      status: httpCodes.OK,
      message: "All clinic departments fetched successfully",
      data: data.data,
      totalCount: data.totalCount,
      pageCount: data.pageCount,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const createDepartment = async (c: Context) => {
  try {
    const user = c.get("user");
    if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const validatedFields = createDepartmentSchema.safeParse(
      await c.req.json()
    );
    if (!validatedFields.success) {
      return c.json({
        error: validatedFields.error.flatten().fieldErrors,
        status: httpCodes.BAD_REQUEST,
      });
    }

    const { name, isActive } = validatedFields.data;

    // Check if department with this name already exists
    const existingDepartment = await db.clinicalDepartment.findUnique({
      where: { name },
    });

    if (existingDepartment) {
      return c.json(
        { error: "Department with this name already exists" },
        httpCodes.CONFLICT as ContentfulStatusCode
      );
    }

    const department = await db.clinicalDepartment.create({
      data: {
        name,
        isActive: isActive ?? true,
      },
      include: {
        _count: {
          select: {
            users: true,
            visits: true,
            clinics: true,
          },
        },
      },
    });

    return c.json({
      status: httpCodes.CREATED,
      message: "Department created successfully",
      data: department,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getDepartmentById = async (c: Context) => {
  try {
    const user = c.get("user");
    if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const { id } = c.get("validatedParam");
    const departmentId = Number.parseInt(id, 10);

    const department = await db.clinicalDepartment.findUnique({
      where: { id: departmentId },
      include: {
        users: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
        visits: {
          take: 10,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            status: true,
            createdAt: true,
            patient: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
        clinics: {
          select: {
            id: true,
            name: true,
          },
        },
        _count: {
          select: {
            users: true,
            visits: true,
            clinics: true,
          },
        },
      },
    });

    if (!department) {
      return c.json(
        { error: "Department not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    // Check if user has access to this department
    if (
      user.role !== Role.SUPER_ADMIN &&
      !department.clinics.some((clinic) => clinic.id === user.clinicId)
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    return c.json({
      status: httpCodes.OK,
      message: "Department fetched successfully",
      data: department,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updateDepartment = async (c: Context) => {
  try {
    const user = c.get("user");
    if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const { id } = c.get("validatedParam");
    const departmentId = Number.parseInt(id, 10);

    const validatedFields = updateDepartmentSchema.safeParse(
      await c.req.json()
    );
    if (!validatedFields.success) {
      return c.json({
        error: validatedFields.error.flatten().fieldErrors,
        status: httpCodes.BAD_REQUEST,
      });
    }

    // Check if department exists
    const existingDepartment = await db.clinicalDepartment.findUnique({
      where: { id: departmentId },
      include: {
        clinics: {
          select: { id: true },
        },
      },
    });

    if (!existingDepartment) {
      return c.json(
        { error: "Department not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    // Check if user has access to this department
    if (
      user.role !== Role.SUPER_ADMIN &&
      !existingDepartment.clinics.some((clinic) => clinic.id === user.clinicId)
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    // Check if name is being updated and if it already exists
    if (
      validatedFields.data.name &&
      validatedFields.data.name !== existingDepartment.name
    ) {
      const nameExists = await db.clinicalDepartment.findUnique({
        where: { name: validatedFields.data.name },
      });

      if (nameExists && nameExists.id !== departmentId) {
        return c.json(
          { error: "Department with this name already exists" },
          httpCodes.CONFLICT as ContentfulStatusCode
        );
      }
    }

    const updatedDepartment = await db.clinicalDepartment.update({
      where: { id: departmentId },
      data: validatedFields.data,
      include: {
        _count: {
          select: {
            users: true,
            visits: true,
            clinics: true,
          },
        },
      },
    });

    return c.json({
      status: httpCodes.OK,
      message: "Department updated successfully",
      data: updatedDepartment,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const deleteDepartment = async (c: Context) => {
  try {
    const user = c.get("user");
    if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const { id } = c.get("validatedParam");
    const departmentId = Number.parseInt(id, 10);

    // Check if department exists
    const existingDepartment = await db.clinicalDepartment.findUnique({
      where: { id: departmentId },
      include: {
        clinics: {
          select: { id: true },
        },
        _count: {
          select: {
            users: true,
            visits: true,
          },
        },
      },
    });

    if (!existingDepartment) {
      return c.json(
        { error: "Department not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    // Check if user has access to this department
    if (
      user.role !== Role.SUPER_ADMIN &&
      !existingDepartment.clinics.some((clinic) => clinic.id === user.clinicId)
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    // Check if department is in use
    if (
      existingDepartment._count.users > 0 ||
      existingDepartment._count.visits > 0
    ) {
      return c.json(
        { error: "Cannot delete department that is in use" },
        httpCodes.CONFLICT as ContentfulStatusCode
      );
    }

    await db.clinicalDepartment.delete({
      where: { id: departmentId },
    });

    return c.json({
      status: httpCodes.OK,
      message: "Department deleted successfully",
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const createClinicDepartments = async (c: Context) => {
  try {
    const user = c.get("user");
    if (user.role !== Role.CLINIC_ADMIN && user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const validatedFields = createClinicDepartmentsSchema.safeParse(
      await c.req.json()
    );
    if (!validatedFields.success) {
      return c.json({
        error: validatedFields.error.flatten().fieldErrors,
        status: httpCodes.BAD_REQUEST,
      });
    }

    const { departments } = validatedFields.data;

    // Verify all departments exist
    const existingDepartments = await db.clinicalDepartment.findMany({
      where: {
        id: {
          in: departments.map((id) => Number.parseInt(id, 10)),
        },
      },
    });

    if (existingDepartments.length !== departments.length) {
      return c.json(
        { error: "One or more departments not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    // Update clinic with new departments
    const updatedClinic = await db.clinic.update({
      where: { id: user.clinicId },
      data: {
        departments: {
          connect: departments.map((departmentId) => ({
            id: Number.parseInt(departmentId, 10),
          })),
        },
      },
      include: {
        departments: {
          select: {
            id: true,
            name: true,
            isActive: true,
          },
        },
      },
    });

    return c.json(
      {
        status: httpCodes.OK,
        success: true,
        message: "Departments added to clinic successfully",
        data: updatedClinic.departments,
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

export const getClinicalDepartmentsList = async (c: Context) => {
  try {
    const departments = await db.clinicalDepartment.findMany({
      where: {
        isActive: true,
      },
      select: {
        id: true,
        name: true,
      },
      orderBy: {
        name: "asc",
      },
    });

    return c.json(
      {
        status: httpCodes.OK,
        message: "Clinical departments list fetched successfully",
        data: departments,
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

export const getDepartmentsByClinicId = async (c: Context) => {
  try {
    const user = c.get("user");
    const { clinicId } = c.get("validatedParam");

    // Only allow access to own clinic unless super admin
    if (
      user.role !== Role.SUPER_ADMIN &&
      user.clinicId !== Number.parseInt(clinicId, 10)
    ) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const departments = await db.clinicalDepartment.findMany({
      where: {
        clinics: {
          some: {
            id: Number.parseInt(clinicId, 10),
          },
        },
      },
      select: {
        id: true,
        name: true,
        isActive: true,
      },
      orderBy: {
        name: "asc",
      },
    });

    return c.json({
      status: httpCodes.OK,
      message: "Clinic departments fetched successfully",
      data: departments,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getProductsDepartmentsList = async (c: Context) => {
  try {
    const departments = await db.department.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: {
        name: "asc",
      },
    });

    return c.json({
      status: httpCodes.OK,
      message: "Departments list fetched successfully",
      data: departments,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const assignDepartmentsToClinic = async (c: Context) => {
  try {
    const user = c.get("user");
    if (user.role !== Role.SUPER_ADMIN) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    const data = c.get("validatedJson");
    const { clinicId } = c.get("validatedParam");
    const clinic = await db.clinic.findUnique({
      where: { id: Number.parseInt(clinicId, 10) },
    });
    if (!clinic) {
      return c.json(
        { error: "Clinic not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    //Verify all departments exist
    const existingDepartments = await db.clinicalDepartment.findMany({
      where: {
        id: {
          in: data.departments.map((id: string) => Number.parseInt(id, 10)),
        },
      },
    });
    if (existingDepartments.length !== data.departments.length) {
      return c.json(
        { error: "One or more departments not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    const updatedClinic = await db.clinic.update({
      where: { id: Number.parseInt(clinicId, 10) },
      data: {
        departments: {
          connect: data.departments.map((id: string) => ({
            id: Number.parseInt(id, 10),
          })),
        },
      },
      include: {
        departments: {
          select: {
            id: true,
            name: true,
            isActive: true,
          },
        },
      },
    });
    return c.json({
      status: httpCodes.OK,
      message: "Departments assigned to clinic successfully",
      data: updatedClinic.departments,
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
