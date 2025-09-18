import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { httpCodes } from "@/lib/constants.ts";
import type {
  EducationLevel,
  Prisma,
  Role,
  UserStatus,
} from "../../../../generated/prisma";
import { db } from "../../../database/db";
import { updateUserSchema } from "./users.validation.ts";

export const listUsers = async (c: Context) => {
  try {
    const { page = "1", limit = "10", search = "", role = "" } = c.req.query();

    const skip = (Number.parseInt(page, 10) - 1) * Number.parseInt(limit, 10);
    const take = Number.parseInt(limit, 10);

    const where: Prisma.UserWhereInput = {};

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }

    if (role) {
      where.role = role as Role;
    }

    const [users, total] = await Promise.all([
      db.user.findMany({
        where,
        skip,
        take,
        include: { clinic: true, branch: true },
        orderBy: { createdAt: "desc" },
      }),
      db.user.count({ where }),
    ]);

    return c.json({
      data: users,
      total,
      page: Number.parseInt(page, 10),
      limit: Number.parseInt(limit, 10),
      totalPages: Math.ceil(total / Number.parseInt(limit, 10)),
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

// Validation schemas are defined in users.validation.ts

export const getUserById = async (c: Context) => {
  try {
    const { id } = c.req.param();
    const user = await db.user.findUnique({
      where: { id: Number(id) },
      include: { clinic: true, branch: true },
    });
    if (!user) {
      return c.json(
        { error: "User not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    return c.json({ data: user });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updateUser = async (c: Context) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json();
    const validatedData = updateUserSchema.parse(body);

    const {
      clinicId,
      branchId,
      role,
      status,
      highestEducation,
      ...updateData
    } = validatedData;
    const data: Prisma.UserUpdateInput = {
      ...updateData,
      ...(role && { role: role as Role }),
      ...(status && { status: status as UserStatus }),
      ...(highestEducation && {
        highestEducation: highestEducation as EducationLevel,
      }),
      ...(clinicId && { clinic: { connect: { id: clinicId } } }),
      ...(branchId && { branch: { connect: { id: branchId } } }),
    };

    const user = await db.user.update({
      where: { id: Number(id) },
      data,
      include: { clinic: true, branch: true },
    });
    return c.json({ data: user });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json(
        { error: "Validation error", details: error.issues },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const deleteUser = async (c: Context) => {
  try {
    const { id } = c.req.param();
    await db.user.delete({ where: { id: Number(id) } });
    return c.json({ success: true });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
