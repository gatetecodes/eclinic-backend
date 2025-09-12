import { type Context } from "hono";
import { db } from "../../../database/db";

export const listClinics = async (c: Context) => {
  try {
    const clinics = await db.clinic.findMany({
      include: {
        branches: true,
        _count: { select: { users: true, patients: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return c.json({ data: clinics });
  } catch (error) {
    console.error("Get clinics error:", error);
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
