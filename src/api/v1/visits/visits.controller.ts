import { type Context } from "hono";
import { db } from "../../../database/db";
import type { Prisma, VisitStatus } from "../../../../generated/prisma";

export const listVisits = async (c: Context) => {
  try {
    const {
      page = "1",
      limit = "10",
      status = "",
      doctorId = "",
      patientId = "",
    } = c.req.query();

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where: Prisma.VisitWhereInput = {};
    if (status) where.status = status as VisitStatus;
    if (doctorId) where.doctorId = parseInt(doctorId);
    if (patientId) where.patientId = parseInt(patientId);

    const [visits, total] = await Promise.all([
      db.visit.findMany({
        where,
        skip,
        take,
        include: {
          patient: true,
          doctor: true,
          clinic: true,
          branch: true,
          department: true,
          payments: true,
          prescriptions: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      db.visit.count({ where }),
    ]);

    return c.json({
      data: visits,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (error) {
    console.error("Get visits error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};

export const getVisitById = async (c: Context) => {
  try {
    const { id } = c.req.param();
    const visit = await db.visit.findUnique({
      where: { id: parseInt(id) },
      include: {
        patient: true,
        doctor: true,
        clinic: true,
        branch: true,
        department: true,
        payments: true,
        prescriptions: true,
        examResults: true,
        treatments: true,
      },
    });

    if (!visit) return c.json({ error: "Visit not found" }, 404);
    return c.json({ data: visit });
  } catch (error) {
    console.error("Get visit error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};
