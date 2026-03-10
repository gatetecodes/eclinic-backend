import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "@/lib/constants";
import {
  fetchAccountantStats,
  fetchCashFlow,
  fetchDashboardOverview,
  fetchDoctorStats,
  fetchImportantStatusesVisitsCount,
  fetchLabTechnicianStats,
  fetchNurseStats,
  fetchPatientsByAge,
  fetchStockManagerStats,
  fetchVisitsByDepartments,
} from "./dashboard-batch.service";

export async function getDashboardBatch(c: Context) {
  try {
    const user = c.get("user") as {
      id: string | number;
      role: string;
      clinicId?: number;
    };
    const userId = typeof user.id === "string" ? Number(user.id) : user.id;
    const clinicId = c.get("clinicId") as number | undefined;

    if (!clinicId && user.role !== "SUPER_ADMIN") {
      return c.json(
        { error: "Clinic context required" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const clinicIdNum = clinicId as number;

    switch (user.role) {
      case "CLINIC_ADMIN": {
        const [
          overview,
          patientsByAge,
          cashFlow,
          departments,
          importantStatuses,
        ] = await Promise.all([
          fetchDashboardOverview(clinicIdNum),
          fetchPatientsByAge(clinicIdNum, "week", null),
          fetchCashFlow(clinicIdNum, "year"),
          fetchVisitsByDepartments(clinicIdNum, null),
          fetchImportantStatusesVisitsCount(clinicIdNum),
        ]);

        return c.json(
          {
            data: {
              role: "CLINIC_ADMIN",
              overview,
              patientsByAge,
              cashFlow,
              departments,
              importantStatuses,
            },
          },
          httpCodes.OK as ContentfulStatusCode
        );
      }

      case "DOCTOR": {
        const [doctorStats, patientsByAge, departments] = await Promise.all([
          fetchDoctorStats(userId),
          fetchPatientsByAge(clinicIdNum, "week", userId),
          fetchVisitsByDepartments(clinicIdNum, userId),
        ]);

        return c.json(
          {
            data: {
              role: "DOCTOR",
              doctorStats,
              patientsByAge,
              departments,
            },
          },
          httpCodes.OK as ContentfulStatusCode
        );
      }

      case "NURSE": {
        const [nurseStats, departments] = await Promise.all([
          fetchNurseStats(userId),
          fetchVisitsByDepartments(clinicIdNum, null),
        ]);

        return c.json(
          {
            data: {
              role: "NURSE",
              nurseStats,
              departments,
            },
          },
          httpCodes.OK as ContentfulStatusCode
        );
      }

      case "CASHIER": {
        const [accountantStats, cashFlow] = await Promise.all([
          fetchAccountantStats(userId),
          fetchCashFlow(clinicIdNum, "year"),
        ]);

        return c.json(
          {
            data: {
              role: "CASHIER",
              accountantStats,
              cashFlow,
            },
          },
          httpCodes.OK as ContentfulStatusCode
        );
      }

      case "LAB_TECHNICIAN": {
        const [labStats, departments] = await Promise.all([
          fetchLabTechnicianStats(userId),
          fetchVisitsByDepartments(clinicIdNum, null),
        ]);

        return c.json(
          {
            data: {
              role: "LAB_TECHNICIAN",
              labStats,
              departments,
            },
          },
          httpCodes.OK as ContentfulStatusCode
        );
      }

      case "STOCK_MANAGER": {
        const stockManagerStats = await fetchStockManagerStats(userId);

        return c.json(
          {
            data: {
              role: "STOCK_MANAGER",
              stockManagerStats,
            },
          },
          httpCodes.OK as ContentfulStatusCode
        );
      }

      default:
        return c.json(
          { error: "Unsupported role for dashboard batch" },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
    }
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
}
