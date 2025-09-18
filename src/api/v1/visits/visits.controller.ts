import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "@/lib/constants";
import type { Prisma, VisitStatus } from "../../../../generated/prisma";
import { db } from "../../../database/db";

export const listVisits = async (c: Context) => {
  try {
    const {
      page = "1",
      limit = "10",
      status = "",
      doctorId = "",
      patientId = "",
    } = c.req.query();

    const skip = (Number.parseInt(page, 10) - 1) * Number.parseInt(limit, 10);
    const take = Number.parseInt(limit, 10);

    const where: Prisma.VisitWhereInput = {};
    if (status) {
      where.status = status as VisitStatus;
    }
    if (doctorId) {
      where.doctorId = Number.parseInt(doctorId, 10);
    }
    if (patientId) {
      where.patientId = Number.parseInt(patientId, 10);
    }

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

export const getVisitById = async (c: Context) => {
  try {
    const { id } = c.req.param();
    const visit = await db.visit.findUnique({
      where: { id: Number.parseInt(id, 10) },
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

    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    return c.json({ data: visit });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
