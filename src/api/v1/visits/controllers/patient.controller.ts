import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { db } from "../../../../database/db";
import { httpCodes } from "../../../../lib/constants";
import { getCachedData } from "../../../../services/redis.service";

export const getPatientsByPhone = async (c: Context) => {
  try {
    const user = c.get("user");
    const { phone } = c.get("validatedJson") as { phone: string };
    const cacheKey = `patients:phone:${phone}`;
    const patients = await getCachedData(
      cacheKey,
      async () =>
        await db.patient.findMany({
          where: {
            AND: [
              { clinics: { some: { id: user.clinicId } } },
              {
                OR: [{ phoneNumber: phone }, { guardianPhoneNumber: phone }],
              },
            ],
          },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            dateOfBirth: true,
            gender: true,
            phoneNumber: true,
            isChild: true,
            guardianPhoneNumber: true,
            medicalInfo: true,
            email: true,
            address: true,
            visits: {
              orderBy: {
                startTime: "desc",
              },
              take: 1,
              select: {
                startTime: true,
              },
            },
          },
        })
    );
    if (!patients.length) {
      return c.json(
        { error: "Patient not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    const patientsWithLastVisit = patients.map((patient) => ({
      ...patient,
      dateLastVisited: patient.visits[0]?.startTime ?? null,
      visits: undefined,
    }));
    return c.json(
      { data: patientsWithLastVisit },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
