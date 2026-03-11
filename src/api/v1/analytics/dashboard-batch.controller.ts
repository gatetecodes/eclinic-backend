import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "@/lib/constants";
import { consume } from "@/services/quotas.service";
import {
  fetchAccountantStats,
  fetchCashFlow,
  fetchDashboardOverview,
  fetchDoctorStats,
  fetchImportantStatusesVisitsCount,
  fetchLabTechnicianStats,
  fetchNurseStats,
  fetchPatientsByAge,
  fetchRoleScopedQueueSummary,
  fetchStockManagerStats,
  fetchVisitsByDepartments,
} from "./dashboard-batch.service";

export async function getDashboardBatch(c: Context) {
  try {
    const user = c.get("user") as {
      id: string | number;
      role: string;
      clinicId?: number;
      branchId?: number | null;
    };
    const userId = typeof user.id === "string" ? Number(user.id) : user.id;
    const clinicId = c.get("clinicId") as number | undefined;
    const branchId = user.branchId ?? undefined;
    const entitlements = c.get("entitlements") as
      | { features: Record<string, boolean> }
      | undefined;

    const hasAnalyticsPro =
      user.role === "SUPER_ADMIN" ||
      entitlements?.features.analyticsPro === true;

    if (!clinicId && user.role !== "SUPER_ADMIN") {
      return c.json(
        { error: "Clinic context required" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const clinicIdNum = clinicId as number;
    const timeRange = (c.req.query("timeRange") as "year") || "year";
    const patientsFilter = (c.req.query("patientsFilter") as "week") || "week";

    switch (user.role) {
      case "SUPER_ADMIN":
      case "BRANCH_ADMIN":
      case "MARKETING":
      case "CLINIC_ADMIN":
        return await handleAdminDashboard({
          c,
          role: user.role,
          clinicId: clinicIdNum,
          hasAnalyticsPro,
          timeRange,
          patientsFilter,
        });

      case "DOCTOR":
        return await handleDoctorDashboard({
          c,
          userId,
          clinicId: clinicIdNum,
          patientsFilter,
          branchId,
        });

      case "NURSE":
        return await handleNurseDashboard(c, userId, clinicIdNum, branchId);

      case "CASHIER":
        return await handleCashierDashboard({
          c,
          userId,
          clinicId: clinicIdNum,
          hasAnalyticsPro,
          timeRange,
        });

      case "LAB_TECHNICIAN":
        return await handleLabDashboard(c, userId, clinicIdNum, branchId);

      case "STOCK_MANAGER":
        return await handleStockDashboard(c, userId);

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

async function handleAdminDashboard(options: {
  c: Context;
  role: string;
  clinicId: number;
  hasAnalyticsPro: boolean;
  timeRange: "year" | "6months" | "3months";
  patientsFilter: "week" | "month" | "3months";
}) {
  const { c, role, clinicId, hasAnalyticsPro, timeRange, patientsFilter } =
    options;
  const [overview, patientsByAge, cashFlow, departments, importantStatuses] =
    await Promise.all([
      fetchDashboardOverview(clinicId),
      fetchPatientsByAge(clinicId, patientsFilter, null),
      hasAnalyticsPro ? fetchCashFlow(clinicId, timeRange) : null,
      fetchVisitsByDepartments(clinicId, null),
      fetchImportantStatusesVisitsCount(clinicId),
    ]);

  if (hasAnalyticsPro && role !== "SUPER_ADMIN") {
    consume(clinicId, "analyticsPro", 1).catch(() => null);
  }

  return c.json(
    {
      data: {
        role,
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

async function handleDoctorDashboard(options: {
  c: Context;
  userId: number;
  clinicId: number;
  patientsFilter: "week" | "month" | "3months";
  branchId?: number | null;
}) {
  const { c, userId, clinicId, patientsFilter, branchId } = options;
  const [doctorStats, patientsByAge, departments, queueSummary] =
    await Promise.all([
      fetchDoctorStats(userId),
      fetchPatientsByAge(clinicId, patientsFilter, userId),
      fetchVisitsByDepartments(clinicId, userId),
      fetchRoleScopedQueueSummary("DOCTOR", clinicId, userId, branchId),
    ]);

  return c.json(
    {
      data: {
        role: "DOCTOR",
        doctorStats,
        patientsByAge,
        departments,
        queueSummary,
      },
    },
    httpCodes.OK as ContentfulStatusCode
  );
}

async function handleNurseDashboard(
  c: Context,
  userId: number,
  clinicId: number,
  branchId?: number | null
) {
  const [nurseStats, departments, queueSummary] = await Promise.all([
    fetchNurseStats(userId),
    fetchVisitsByDepartments(clinicId, null),
    fetchRoleScopedQueueSummary("NURSE", clinicId, userId, branchId),
  ]);

  return c.json(
    {
      data: {
        role: "NURSE",
        nurseStats,
        departments,
        queueSummary,
      },
    },
    httpCodes.OK as ContentfulStatusCode
  );
}

async function handleCashierDashboard(options: {
  c: Context;
  userId: number;
  clinicId: number;
  hasAnalyticsPro: boolean;
  timeRange: "year" | "6months" | "3months";
}) {
  const { c, userId, clinicId, hasAnalyticsPro, timeRange } = options;
  const [accountantStats, cashFlow] = await Promise.all([
    fetchAccountantStats(userId),
    hasAnalyticsPro ? fetchCashFlow(clinicId, timeRange) : null,
  ]);

  if (hasAnalyticsPro) {
    consume(clinicId, "analyticsPro", 1).catch(() => null);
  }

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

async function handleLabDashboard(
  c: Context,
  userId: number,
  clinicId: number,
  branchId?: number | null
) {
  const [labStats, departments, queueSummary] = await Promise.all([
    fetchLabTechnicianStats(userId),
    fetchVisitsByDepartments(clinicId, null),
    fetchRoleScopedQueueSummary("LAB_TECHNICIAN", clinicId, userId, branchId),
  ]);

  return c.json(
    {
      data: {
        role: "LAB_TECHNICIAN",
        labStats,
        departments,
        queueSummary,
      },
    },
    httpCodes.OK as ContentfulStatusCode
  );
}

async function handleStockDashboard(c: Context, userId: number) {
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
