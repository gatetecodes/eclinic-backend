import { type Context } from "hono";
import { z } from "zod";
import { db } from "../../../database/db";
import { updateUserSchema } from "./users.validation.ts";

export const listUsers = async (c: Context) => {
  try {
    const { page = "1", limit = "10", search = "", role = "" } = c.req.query();

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    type StringFilter = { contains: string; mode: "insensitive" };
    type UserWhereInputLite = {
      role?: string;
      OR?: Array<{ name?: StringFilter; email?: StringFilter }>;
    };
    const where: UserWhereInputLite = {};

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }

    if (role) {
      where.role = role;
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
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (error) {
    console.error("Get users error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};

// Validation schemas are defined in users.validation.ts

export const getUserById = async (c: Context) => {
  try {
    const { id } = c.req.param();
    const user = await db.user.findUnique({
      where: { id },
      include: { clinic: true, branch: true },
    });
    if (!user) return c.json({ error: "User not found" }, 404);
    return c.json({ data: user });
  } catch (error) {
    console.error("Get user error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};

export const updateUser = async (c: Context) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json();
    const validatedData = updateUserSchema.parse(body);
    const user = await db.user.update({
      where: { id },
      data: validatedData,
      include: { clinic: true, branch: true },
    });
    return c.json({ data: user });
  } catch (error) {
    console.error("Update user error:", error);
    if (error instanceof z.ZodError) {
      return c.json({ error: "Validation error", details: error.issues }, 400);
    }
    return c.json({ error: "Internal Server Error" }, 500);
  }
};

export const deleteUser = async (c: Context) => {
  try {
    const { id } = c.req.param();
    await db.user.delete({ where: { id } });
    return c.json({ success: true });
  } catch (error) {
    console.error("Delete user error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};
