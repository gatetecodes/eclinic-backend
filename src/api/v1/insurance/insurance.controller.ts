import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { db } from "../../../database/db";
import { httpCodes } from "../../../lib/constants";

export const getInsuranceByNumber = async (c: Context) => {
  try {
    const insuranceNumber = c.req.param("insuranceNumber");
    const insuranceRecords = await db.patientInsurance.findMany({
      where: {
        insuranceNumber: {
          equals: insuranceNumber,
        },
      },
      select: {
        id: true,
        coveragePercentage: true,
        insuranceNumber: true,
        insuranceCompany: {
          select: {
            id: true,
            companyName: true,
          },
        },
        employer: {
          select: {
            id: true,
            employerName: true,
          },
        },
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
          },
        },
      },
    });

    return c.json(
      { data: insuranceRecords },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getInsuranceByPatientId = async (c: Context) => {
  try {
    const patientId = c.req.param("patientId");
    const insurance = await db.patientInsurance.findFirst({
      where: {
        patientId: Number(patientId),
      },
    });
    if (!insurance) {
      return c.json(
        { error: "Insurance not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    return c.json({ data: insurance }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const createNewInsuranceCompany = async (c: Context) => {
  try {
    const data = c.get("validatedJson");
    const insurance = await db.insuranceCompany.create({
      data,
    });
    return c.json({ data: insurance }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const createNewEmployer = async (c: Context) => {
  try {
    const data = c.get("validatedJson");
    const employer = await db.employer.create({
      data,
    });

    return c.json({ data: employer }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const createNewPatientInsurance = async (c: Context) => {
  try {
    const data = c.get("validatedJson");
    const preparedData = {
      ...data,
      insuranceCompanyId: +data.insuranceCompanyId,
      employerId: data.employerId ? +data.employerId : undefined,
      patientId: +data.patientId,
    };
    const patientInsurance = await db.patientInsurance.create({
      data: preparedData,
    });

    return c.json(
      { data: patientInsurance },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getEmployersList = async (c: Context) => {
  try {
    const employers = await db.employer.findMany({
      select: {
        id: true,
        employerName: true,
      },
    });
    return c.json({ data: employers }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getInsuranceCompaniesList = async (c: Context) => {
  try {
    const insuranceCompanies = await db.insuranceCompany.findMany({
      select: {
        id: true,
        companyName: true,
      },
    });
    return c.json(
      { data: insuranceCompanies },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
