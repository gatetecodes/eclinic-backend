import type { Context } from "hono";
import type { Prisma } from "../../../../generated/prisma/client";
import { db } from "../../../database/db";
import type { AppEnv } from "../../../middlewares/auth.middleware";

export const listPatients = async (c: Context<AppEnv>) => {
  try {
    const { page = "1", limit = "10", search = "" } = c.req.query();
    const clinicId = c.get("clinicId");
    const normalizedSearch = search.trim();

    const skip = (Number.parseInt(page, 10) - 1) * Number.parseInt(limit, 10);
    const take = Number.parseInt(limit, 10);

    const where: Prisma.PatientWhereInput = {
      clinics:
        typeof clinicId === "number" ? { some: { id: clinicId } } : undefined,
    };

    if (normalizedSearch) {
      where.OR = [
        { patientId: { contains: normalizedSearch, mode: "insensitive" } },
        { firstName: { contains: normalizedSearch, mode: "insensitive" } },
        { lastName: { contains: normalizedSearch, mode: "insensitive" } },
        { email: { contains: normalizedSearch, mode: "insensitive" } },
        { phoneNumber: { contains: normalizedSearch, mode: "insensitive" } },
        {
          guardianPhoneNumber: {
            contains: normalizedSearch,
            mode: "insensitive",
          },
        },
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
          // Most-recent insurance policy, used to surface the patient's insurer
          // in the registry. A patient may hold several; we expose the latest.
          patientInsurance: {
            take: 1,
            orderBy: { id: "desc" },
            include: { insuranceCompany: { select: { companyName: true } } },
          },
          visits: { take: 5, orderBy: { createdAt: "desc" } },
        },
        orderBy: { createdAt: "desc" },
      }),
      db.patient.count({ where }),
    ]);

    // Flatten the latest insurance into `insurer` / `coveragePercentage` so the
    // registry UI can render an insurer column/field without walking relations.
    const data = patients.map((patient) => {
      const policy = patient.patientInsurance?.[0];
      const { patientInsurance: _omit, ...rest } = patient;
      return {
        ...rest,
        insurer: policy?.insuranceCompany?.companyName ?? null,
        coveragePercentage:
          policy?.coveragePercentage != null
            ? Number(policy.coveragePercentage)
            : null,
      };
    });

    return c.json({
      data,
      total,
      page: Number.parseInt(page, 10),
      limit: Number.parseInt(limit, 10),
      totalPages: Math.ceil(total / Number.parseInt(limit, 10)),
    });
  } catch (_error) {
    return c.json({ error: "Internal Server Error" }, 500);
  }
};
