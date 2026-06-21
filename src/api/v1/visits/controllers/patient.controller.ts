import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { db } from "../../../../database/db";
import { httpCodes } from "../../../../lib/constants";
import { getCachedData } from "../../../../services/redis.service";

export const getPatientsByPhone = async (c: Context) => {
  try {
    const user = c.get("user");
    const phone = c.get("validatedJson") as string;
    const cacheKey = `patients:phone:${user.clinicId}:${phone}`;
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
            isAForeigner: true,
            foreignerRegion: true,
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
            // Most recent insurance on record — lets reception show the
            // patient's payment method without re-asking for it.
            patientInsurance: {
              orderBy: {
                createdAt: "desc",
              },
              take: 1,
              select: {
                insuranceNumber: true,
                coveragePercentage: true,
                insuranceCompany: { select: { companyName: true } },
              },
            },
          },
        }),
      undefined,
      { cacheEmpty: false }
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
      {
        status: httpCodes.OK,
        success: true,
        message: "Patients fetched successfully",
        data: patientsWithLastVisit,
      },
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
