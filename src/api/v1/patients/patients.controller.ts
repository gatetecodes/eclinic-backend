import { type Context } from "hono";
import { db } from "../../../database/db";

export const listPatients = async (c: Context) => {
  try {
    const { page = "1", limit = "10", search = "" } = c.req.query();

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

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
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (error) {
    console.error("Get patients error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};
