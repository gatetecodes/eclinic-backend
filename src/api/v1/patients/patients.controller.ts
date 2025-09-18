import type { Context } from "hono";
import { db } from "../../../database/db";

export const listPatients = async (c: Context) => {
  try {
    const { page = "1", limit = "10", search = "" } = c.req.query();

    const skip = (Number.parseInt(page, 10) - 1) * Number.parseInt(limit, 10);
    const take = Number.parseInt(limit, 10);

    type StringFilter = { contains: string; mode: "insensitive" };
    type PatientWhereInputLite = {
      OR?: Array<
        | { firstName: StringFilter }
        | { lastName: StringFilter }
        | { email: StringFilter }
        | { phoneNumber: StringFilter }
      >;
    };
    const where: PatientWhereInputLite = {};

    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: "insensitive" } },
        { lastName: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { phoneNumber: { contains: search, mode: "insensitive" } },
      ];
    }

    const [patients, total] = await Promise.all([
      db.patient.findMany({
        where,
        skip,
        take,
        include: {
          clinics: true,
          branches: true,
          visits: { take: 5, orderBy: { createdAt: "desc" } },
        },
        orderBy: { createdAt: "desc" },
      }),
      db.patient.count({ where }),
    ]);

    return c.json({
      data: patients,
      total,
      page: Number.parseInt(page, 10),
      limit: Number.parseInt(limit, 10),
      totalPages: Math.ceil(total / Number.parseInt(limit, 10)),
    });
  } catch (_error) {
    return c.json({ error: "Internal Server Error" }, 500);
  }
};
