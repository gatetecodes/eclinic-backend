import {
  eachDayOfInterval,
  eachMonthOfInterval,
  endOfDay,
  endOfYear,
  format,
  startOfDay,
  startOfYear,
  subDays,
  subMonths,
  subWeeks,
  subYears,
} from "date-fns";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { calculateTrend, calculateTrendText } from "@/helpers/analytics-helper";
import { httpCodes } from "@/lib/constants";
import {
  EventType,
  ExamStatus,
  InventoryStatus,
  PaymentMode,
  PaymentStatus,
  type Prisma,
  VisitStatus,
} from "../../../../generated/prisma";
import { db } from "../../../database/db";

const MONTHS_IN_6_MONTHS = 6;
const MONTHS_IN_3_MONTHS = 3;

export const getDashboard = async (c: Context) => {
  try {
    const [totalPatients, totalVisits, totalRevenue, totalUsers] =
      await Promise.all([
        db.patient.count(),
        db.visit.count(),
        db.payment.aggregate({ _sum: { amount: true } }),
        db.user.count(),
      ]);

    return c.json({
      data: {
        totalPatients,
        totalVisits,
        totalRevenue: totalRevenue._sum.amount || 0,
        totalUsers,
      },
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

// Frontend parity: getDashboardOverview
export const getDashboardOverview = async (c: Context) => {
  try {
    const clinicId = c.get("clinicId");
    const now = new Date();
    const today = new Date(now.setHours(0, 0, 0, 0));
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const [currentDay, previousDay] = await Promise.all([
      db.$transaction([
        db.payment.count({
          where: { createdAt: { gte: today }, clinicId },
        }),
        db.visit.count({
          where: { createdAt: { gte: today }, clinicId },
        }),
        db.event.count({
          where: {
            type: "APPOINTMENT",
            createdAt: { gte: today },
            clinicId,
          },
        }),
        db.payment.aggregate({
          _sum: { amount: true },
          where: { createdAt: { gte: today }, clinicId },
        }),
      ]),
      db.$transaction([
        db.payment.count({
          where: {
            createdAt: { gte: yesterday, lt: today },
            clinicId,
          },
        }),
        db.visit.count({
          where: {
            createdAt: { gte: yesterday, lt: today },
            clinicId,
          },
        }),
        db.event.count({
          where: {
            type: "APPOINTMENT",
            createdAt: { gte: yesterday, lt: today },
            clinicId,
          },
        }),
        db.payment.aggregate({
          _sum: { amount: true },
          where: {
            createdAt: { gte: yesterday, lt: today },
            clinicId,
          },
        }),
      ]),
    ]);

    return c.json(
      {
        status: httpCodes.OK,
        message: "Dashboard overview fetched successfully",
        data: {
          totalPayments: {
            count: currentDay[0],
            trend: calculateTrend(currentDay[0], previousDay[0]),
            trendText: calculateTrendText(currentDay[0], previousDay[0]),
          },
          totalVisits: {
            count: currentDay[1],
            trend: calculateTrend(currentDay[1], previousDay[1]),
            trendText: calculateTrendText(currentDay[1], previousDay[1]),
          },
          totalAppointments: {
            count: currentDay[2],
            trend: calculateTrend(currentDay[2], previousDay[2]),
            trendText: calculateTrendText(currentDay[2], previousDay[2]),
          },
          totalRevenue: {
            count: Number(currentDay[3]._sum.amount || 0),
            trend: calculateTrend(
              Number(currentDay[3]._sum.amount || 0),
              Number(previousDay[3]._sum.amount || 0)
            ),
            trendText: calculateTrendText(
              Number(currentDay[3]._sum.amount || 0),
              Number(previousDay[3]._sum.amount || 0)
            ),
          },
        },
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

// Frontend parity: getPatientsByAge
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
export const getPatientsByAge = async (c: Context) => {
  try {
    const clinicId = c.get("clinicId");
    const querySchema = z.object({
      timeRange: z.enum(["week", "month", "3months"]).default("3months"),
      doctorId: z.string().optional(),
    });
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten() },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const { timeRange, doctorId } = parsed.data;

    const now = new Date();
    let startDate: Date;
    switch (timeRange) {
      case "week":
        startDate = subWeeks(now, 1);
        break;
      case "month":
        startDate = subMonths(now, 1);
        break;
      default:
        startDate = subMonths(now, MONTHS_IN_3_MONTHS);
    }

    const patients = await db.patient.findMany({
      where: {
        visits: {
          some: {
            createdAt: { gte: startDate },
            clinicId,
            doctorId: doctorId ? Number(doctorId) : undefined,
          },
        },
      },
      select: {
        dateOfBirth: true,
        visits: {
          where: { createdAt: { gte: startDate }, clinicId },
          select: { createdAt: true },
        },
      },
    });

    const days = eachDayOfInterval({ start: startDate, end: now });
    const dailyGroups: Record<
      string,
      { child: number; adult: number; elderly: number }
    > = {};
    for (const day of days) {
      dailyGroups[format(day, "yyyy-MM-dd")] = {
        child: 0,
        adult: 0,
        elderly: 0,
      };
    }

    for (const patient of patients) {
      const yearOfBirth = patient.dateOfBirth
        ? new Date(patient.dateOfBirth as unknown as string).getFullYear()
        : undefined;
      for (const visit of patient.visits) {
        const visitDate = format(new Date(visit.createdAt), "yyyy-MM-dd");
        const age = yearOfBirth
          ? new Date(visit.createdAt).getFullYear() - yearOfBirth
          : undefined;
        if (dailyGroups[visitDate]) {
          if (age && age < 18) {
            dailyGroups[visitDate].child++;
          } else if (age && age >= 18 && age <= 65) {
            dailyGroups[visitDate].adult++;
          } else {
            dailyGroups[visitDate].elderly++;
          }
        }
      }
    }

    const result = Object.entries(dailyGroups).map(([date, groups]) => ({
      date,
      child: groups.child,
      adult: groups.adult,
      elderly: groups.elderly,
    }));
    return c.json({
      data: result,
      status: httpCodes.OK,
      message: "Patients by age fetched successfully",
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

// Frontend parity: getCashFlow
export const getCashFlow = async (c: Context) => {
  try {
    const clinicId = c.get("clinicId");
    const querySchema = z.object({
      timeRange: z.enum(["year", "6months", "3months"]).default("year"),
    });
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten() },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const { timeRange } = parsed.data;

    const now = new Date();
    let startDate: Date;
    let previousStartDate: Date;
    switch (timeRange) {
      case "year":
        startDate = startOfYear(now);
        previousStartDate = subYears(startDate, 1);
        break;
      case "6months":
        startDate = subMonths(now, MONTHS_IN_6_MONTHS);
        previousStartDate = subMonths(startDate, MONTHS_IN_6_MONTHS);
        break;
      default:
        startDate = subMonths(now, MONTHS_IN_3_MONTHS);
        previousStartDate = subMonths(startDate, MONTHS_IN_3_MONTHS);
        break;
    }

    const endDate = endOfYear(now);
    const [currentData, previousData] = await Promise.all([
      getDataForRange(startDate, endDate, clinicId),
      getDataForRange(previousStartDate, startDate, clinicId),
    ]);

    const monthlyData = eachMonthOfInterval({
      start: startDate,
      end: endDate,
    }).map((month) => {
      const monthStr = format(month, "MMM");
      return {
        month: monthStr,
        income: currentData.monthlyIncome[monthStr] || 0,
        expenses: currentData.monthlyExpenses[monthStr] || 0,
        cashFlow:
          (currentData.monthlyIncome[monthStr] || 0) -
          (currentData.monthlyExpenses[monthStr] || 0),
      };
    });

    const totalCashFlow = currentData.totalIncome - currentData.totalExpenses;
    const previousTotalCashFlow =
      previousData.totalIncome - previousData.totalExpenses;

    return c.json(
      {
        status: httpCodes.OK,
        message: "Cash flow fetched successfully",
        data: {
          monthlyData,
          totalIncome: currentData.totalIncome,
          totalExpenses: currentData.totalExpenses,
          totalCashFlow,
          trend: calculateTrend(totalCashFlow, previousTotalCashFlow),
          trendText: calculateTrendText(totalCashFlow, previousTotalCashFlow),
        },
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      {
        error: "Internal Server Error",
        status: httpCodes.INTERNAL_SERVER_ERROR,
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getImportantStatusesVisitsCount = async (c: Context) => {
  try {
    const clinicId = c.get("clinicId");
    const now = new Date();
    // Current day window
    const startDate = startOfDay(now);
    const endDate = endOfDay(now);

    const importantStatuses = [
      VisitStatus.CHECKED_IN,
      VisitStatus.TRIAGE_COMPLETED,
      VisitStatus.IN_CONSULTATION,
      VisitStatus.PENDING_TESTS,
      VisitStatus.DISCHARGED,
      VisitStatus.DISCHARGED_WITH_PRESCRIPTION,
      VisitStatus.ADMITTED,
    ];
    const returnedStatuses = [
      VisitStatus.CHECKED_IN, // Combined: CHECKED_IN + TRIAGE_COMPLETED
      VisitStatus.IN_CONSULTATION,
      VisitStatus.PENDING_TESTS,
      VisitStatus.DISCHARGED, // Combined: DISCHARGED + DISCHARGED_WITH_PRESCRIPTION
      VisitStatus.ADMITTED,
    ];

    const [currentData] = await Promise.all([
      db.visit.groupBy({
        by: ["status"],
        where: {
          createdAt: { gte: startDate, lte: endDate },
          clinicId,
          status: { in: importantStatuses },
        },
        _count: { id: true },
      }),
    ]);

    // Initialize returned statuses with 0, then overlay actual counts, combining discharge variants
    const currentDataByStatus = returnedStatuses.reduce(
      (acc, status) => {
        acc[status] = 0;
        return acc;
      },
      {} as Record<VisitStatus, number>
    );
    let dischargedTotal = 0;
    let checkinTotal = 0;
    for (const row of currentData) {
      if (
        row.status === VisitStatus.DISCHARGED ||
        row.status === VisitStatus.DISCHARGED_WITH_PRESCRIPTION
      ) {
        dischargedTotal += row._count.id;
      } else if (
        row.status === VisitStatus.CHECKED_IN ||
        row.status === VisitStatus.TRIAGE_COMPLETED
      ) {
        checkinTotal += row._count.id;
      } else {
        currentDataByStatus[row.status] = row._count.id;
      }
    }
    currentDataByStatus[VisitStatus.DISCHARGED] = dischargedTotal;
    currentDataByStatus[VisitStatus.CHECKED_IN] = checkinTotal;
    const totalVisits = currentData.reduce(
      (acc, curr) => acc + curr._count.id,
      0
    );

    return c.json(
      {
        status: httpCodes.OK,
        message: "Important statuses visits count fetched successfully",
        data: {
          totalVisits,
          currentDataByStatus,
        },
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      {
        error: "Internal Server Error",
        status: httpCodes.INTERNAL_SERVER_ERROR,
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

async function getDataForRange(
  startDate: Date,
  endDate: Date,
  clinicId: number
) {
  const [incomeData, expenseData, discountData] = await Promise.all([
    db.payment.groupBy({
      by: ["createdAt"],
      where: {
        createdAt: { gte: startDate, lt: endDate },
        paymentStatus: { in: ["PAID", "FULLY_PAID"] },
        clinicId,
      },
      _sum: { amount: true },
    }),
    db.expense.groupBy({
      by: ["createdAt"],
      where: { createdAt: { gte: startDate, lt: endDate }, clinicId },
      _sum: { amount: true },
    }),
    db.discount.groupBy({
      by: ["createdAt"],
      where: {
        createdAt: { gte: startDate, lt: endDate },
        approval: { status: "APPROVED" },
        clinicId,
      },
      _sum: { amount: true },
    }),
  ]);

  const monthlyIncome: Record<string, number> = {};
  const monthlyExpenses: Record<string, number> = {};
  let totalIncome = 0;
  let totalExpenses = 0;

  for (const item of incomeData) {
    const {
      createdAt,
      _sum,
    }: { createdAt: Date; _sum: { amount: Prisma.Decimal | null } } = item;
    const monthKey = format(createdAt, "MMM");
    monthlyIncome[monthKey] =
      (monthlyIncome[monthKey] || 0) + Number(_sum.amount || 0);
    totalIncome += Number(_sum.amount || 0);
  }
  for (const item of discountData) {
    const {
      createdAt,
      _sum,
    }: { createdAt: Date; _sum: { amount: Prisma.Decimal | null } } = item;
    const monthKey = format(createdAt, "MMM");
    monthlyIncome[monthKey] =
      (monthlyIncome[monthKey] || 0) - Number(_sum.amount || 0);
    totalIncome -= Number(_sum.amount || 0);
  }
  for (const item of expenseData) {
    const {
      createdAt,
      _sum,
    }: { createdAt: Date; _sum: { amount: Prisma.Decimal | null } } = item;
    const monthKey = format(createdAt, "MMM");
    monthlyExpenses[monthKey] =
      (monthlyExpenses[monthKey] || 0) + Number(_sum.amount || 0);
    totalExpenses += Number(_sum.amount || 0);
  }

  return { monthlyIncome, monthlyExpenses, totalIncome, totalExpenses };
}

// Frontend parity: countVisitsByDepartments
export const countVisitsByDepartments = async (c: Context) => {
  try {
    const clinicId = c.get("clinicId");
    const querySchema = z.object({ userId: z.string().optional() });
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten() },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const { userId } = parsed.data;

    const visits = await db.visit.groupBy({
      by: ["departmentId"],
      where: {
        doctorId: userId ? Number(userId) : undefined,
        clinicId,
      },
      _count: { id: true },
    });

    const data: { departmentName: string; count: number }[] = [];

    for (const visit of visits) {
      const department = await db.clinicalDepartment.findUnique({
        where: { id: visit.departmentId ?? undefined },
        select: { name: true },
      });
      data.push({
        departmentName: department?.name || "Unknown",
        count: visit._count.id,
      });
    }
    data.sort((a, b) => b.count - a.count);

    const top5 = data.slice(0, 5);
    if (data.length > 5) {
      const othersCount = data
        .slice(5)
        .reduce((acc, curr) => acc + curr.count, 0);
      top5.push({ departmentName: "Others", count: othersCount });
    }
    return c.json({ data: top5 }, httpCodes.OK as ContentfulStatusCode);
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

// Platform analytics parity
export const getClinicsOverview = async (c: Context) => {
  try {
    const today = new Date();
    const yesterday = subDays(today, 1);

    const [
      currentDay,
      previousDay,
      clinicStatusCounts,
      previousClinicStatusCounts,
    ] = await Promise.all([
      db.$transaction([
        db.clinic.count({ where: { subscriptionStatus: "ACTIVE" } }),
        db.user.count({ where: { status: "ACTIVE" } }),
        db.payment.aggregate({
          where: {
            createdAt: { gte: startOfDay(today), lte: endOfDay(today) },
          },
          _sum: { amount: true },
        }),
        db.clinic.count({
          where: {
            createdAt: { gte: startOfDay(today), lte: endOfDay(today) },
          },
        }),
      ]),
      db.$transaction([
        db.clinic.count({
          where: {
            subscriptionStatus: "ACTIVE",
            createdAt: { lte: endOfDay(yesterday) },
          },
        }),
        db.user.count({
          where: { status: "ACTIVE", createdAt: { lte: endOfDay(yesterday) } },
        }),
        db.payment.aggregate({
          where: {
            createdAt: { gte: startOfDay(yesterday), lte: endOfDay(yesterday) },
          },
          _sum: { amount: true },
        }),
        db.clinic.count({
          where: {
            createdAt: { gte: startOfDay(yesterday), lte: endOfDay(yesterday) },
          },
        }),
      ]),
      db.clinic.groupBy({
        by: ["subscriptionStatus"],
        _count: { id: true },
      }),
      db.clinic.groupBy({
        by: ["subscriptionStatus"],
        where: {
          createdAt: { lte: endOfDay(yesterday) },
        },
        _count: { id: true },
      }),
    ]);

    const currentTrials =
      clinicStatusCounts.find((clinic) => clinic.subscriptionStatus === "TRIAL")
        ?._count.id || 0;
    const currentActive =
      clinicStatusCounts.find(
        (clinic) => clinic.subscriptionStatus === "ACTIVE"
      )?._count.id || 0;
    const currentInactive =
      clinicStatusCounts.find(
        (clinic) => clinic.subscriptionStatus === "INACTIVE"
      )?._count.id || 0;
    const totalClinics = currentTrials + currentActive + currentInactive;

    const prevTrials =
      previousClinicStatusCounts.find(
        (clinic) => clinic.subscriptionStatus === "TRIAL"
      )?._count.id || 0;
    const prevActive =
      previousClinicStatusCounts.find(
        (clinic) => clinic.subscriptionStatus === "ACTIVE"
      )?._count.id || 0;
    const prevInactive =
      previousClinicStatusCounts.find(
        (clinic) => clinic.subscriptionStatus === "INACTIVE"
      )?._count.id || 0;
    const previousTotalClinics = prevTrials + prevActive + prevInactive;

    const conversionRate =
      totalClinics > 0
        ? Number(((currentActive / totalClinics) * 100).toFixed(2))
        : 0;

    return c.json(
      {
        data: {
          totalClinics: {
            count: totalClinics,
            trend: calculateTrend(totalClinics, previousTotalClinics),
            trendText: calculateTrendText(totalClinics, previousTotalClinics),
            breakdown: {
              trials: currentTrials,
              converted: currentActive,
              conversionRate,
            },
          },
          activeUsers: {
            count: currentDay[1],
            trend: calculateTrend(currentDay[1], previousDay[1]),
            trendText: calculateTrendText(currentDay[1], previousDay[1]),
          },
          totalRevenue: {
            count: Number(currentDay[2]._sum.amount || 0),
            trend: calculateTrend(
              Number(currentDay[2]._sum.amount || 0),
              Number(previousDay[2]._sum.amount || 0)
            ),
            trendText: calculateTrendText(
              Number(currentDay[2]._sum.amount || 0),
              Number(previousDay[2]._sum.amount || 0)
            ),
          },
          newRegistrations: {
            count: currentDay[3],
            trend: calculateTrend(currentDay[3], previousDay[3]),
            trendText: calculateTrendText(currentDay[3], previousDay[3]),
          },
        },
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getClinicGrowthData = async (c: Context) => {
  try {
    const clinics = await db.clinic.groupBy({
      by: ["subscriptionPlan"],
      _count: { id: true },
    });
    return c.json(
      {
        data: clinics.map(
          (clinic: {
            subscriptionPlan: string | null;
            _count: { id: number };
          }) => ({ plan: clinic.subscriptionPlan, count: clinic._count.id })
        ),
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getTopPerformingClinics = async (c: Context) => {
  try {
    const data = await db.clinic.findMany({
      take: 5,
      orderBy: { visits: { _count: "desc" } },
      include: {
        _count: { select: { visits: true, patients: true } },
        payments: { select: { amount: true } },
      },
    });
    return c.json({ data }, httpCodes.OK as ContentfulStatusCode);
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getClinicsRevenue = async (c: Context) => {
  try {
    const sixMonthsAgo = subMonths(new Date(), MONTHS_IN_6_MONTHS);
    const monthlyRevenue = await db.$queryRaw<
      Array<{ month: Date; revenue: number }>
    >`
      SELECT
        DATE_TRUNC('month', "createdAt") as month,
        SUM(amount) as revenue
      FROM "Payment"
      WHERE "createdAt" >= ${sixMonthsAgo}
      GROUP BY DATE_TRUNC('month', "createdAt")
      ORDER BY month ASC`;
    const data = monthlyRevenue.map(
      (item: { month: Date; revenue: number }) => ({
        month: format(item.month, "MMM yyyy"),
        revenue: Number(item.revenue) || 0,
      })
    );
    return c.json({ data }, httpCodes.OK as ContentfulStatusCode);
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getVisitGrowth = async (c: Context) => {
  try {
    const sixMonthsAgo = subMonths(new Date(), MONTHS_IN_6_MONTHS);

    const monthlyVisits = await db.$queryRaw<
      Array<{ month: Date; visits: number }>
    >`
      SELECT
        DATE_TRUNC('month', "createdAt") as month,
        COUNT(*)::integer as visits
      FROM "Visit"
      WHERE "createdAt" >= ${sixMonthsAgo}
      GROUP BY DATE_TRUNC('month', "createdAt")
      ORDER BY month ASC`;

    const formattedData = monthlyVisits.map((item, index) => {
      const previousVisits =
        index > 0 ? Number(monthlyVisits[index - 1].visits) || 0 : 0;
      const currentVisits = Number(item.visits) || 0;
      const growth = calculateTrend(currentVisits, previousVisits);

      return {
        month: format(item.month, "MMM yyyy"),
        visits: currentVisits,
        growth,
      };
    });

    const clinicGrowth = await db.$queryRaw<
      Array<{
        clinicId: number;
        clinicName: string;
        currentVisits: number;
        previousVisits: number;
      }>
    >`
      WITH current_period AS (
        SELECT
          "clinicId",
          COUNT(*)::integer as visits
        FROM "Visit"
        WHERE "createdAt" >= DATE_TRUNC('month', CURRENT_DATE)
        GROUP BY "clinicId"
      ),
      previous_period AS (
        SELECT
          "clinicId",
          COUNT(*)::integer as visits
        FROM "Visit"
        WHERE "createdAt" >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
          AND "createdAt" < DATE_TRUNC('month', CURRENT_DATE)
        GROUP BY "clinicId"
      )
      SELECT
        c.id as "clinicId",
        c.name as "clinicName",
        COALESCE(cp.visits, 0)::integer as "currentVisits",
        COALESCE(pp.visits, 0)::integer as "previousVisits"
      FROM "Clinic" c
      LEFT JOIN current_period cp ON c.id = cp."clinicId"
      LEFT JOIN previous_period pp ON c.id = pp."clinicId"
      WHERE COALESCE(cp.visits, 0) > 0 OR COALESCE(pp.visits, 0) > 0
      ORDER BY COALESCE(cp.visits, 0) DESC
      LIMIT 10
    `;

    const clinics = clinicGrowth.map((clinic) => ({
      clinicId: clinic.clinicId,
      name: clinic.clinicName,
      growth: calculateTrend(
        Number(clinic.currentVisits),
        Number(clinic.previousVisits)
      ),
    }));

    return c.json(
      {
        data: {
          monthly: formattedData,
          clinics,
        },
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getRevenueGrowth = async (c: Context) => {
  try {
    const sixMonthsAgo = subMonths(new Date(), MONTHS_IN_6_MONTHS);
    const twelveMonthsAgo = subMonths(new Date(), 12);

    const monthlyRevenue = await db.$queryRaw<
      Array<{ month: Date; revenue: number }>
    >`
      SELECT
        DATE_TRUNC('month', "createdAt") as month,
        SUM(amount) as revenue
      FROM "Payment"
      WHERE "createdAt" >= ${sixMonthsAgo}
      GROUP BY DATE_TRUNC('month', "createdAt")
      ORDER BY month ASC`;

    const currentYearRevenue = await db.$queryRaw<
      Array<{ month: Date; revenue: number }>
    >`
      SELECT
        DATE_TRUNC('month', "createdAt") as month,
        SUM(amount) as revenue
      FROM "Payment"
      WHERE "createdAt" >= ${twelveMonthsAgo}
      GROUP BY DATE_TRUNC('month', "createdAt")
      ORDER BY month ASC`;

    const formattedData = monthlyRevenue.map((item, index) => {
      const previousRevenue =
        index > 0 ? Number(monthlyRevenue[index - 1].revenue) || 0 : 0;
      const currentRevenue = Number(item.revenue) || 0;
      const growth = calculateTrend(currentRevenue, previousRevenue);

      const monthKey = format(item.month, "MMM yyyy");
      const sameMonthLastYear = currentYearRevenue.find(
        (r) =>
          format(r.month, "MMM yyyy") === monthKey &&
          format(r.month, "yyyy") !== format(new Date(), "yyyy")
      );
      const yoyGrowth = sameMonthLastYear
        ? calculateTrend(currentRevenue, Number(sameMonthLastYear.revenue) || 0)
        : 0;

      return {
        month: monthKey,
        revenue: currentRevenue,
        growth,
        yoyGrowth,
      };
    });

    return c.json(
      { data: formattedData },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getConversionRate = async (c: Context) => {
  try {
    const allClinics = await db.clinic.findMany({
      select: {
        id: true,
        subscriptionStatus: true,
        subscriptionPlan: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const trials = allClinics.filter(
      (clinic) => clinic.subscriptionStatus === "TRIAL"
    );
    const activeClinics = allClinics.filter(
      (clinic) => clinic.subscriptionStatus === "ACTIVE"
    );
    const converted = allClinics.filter((clinic) => {
      const daysSinceCreated = Math.floor(
        (Date.now() - new Date(clinic.createdAt).getTime()) /
          (1000 * 60 * 60 * 24)
      );
      return clinic.subscriptionStatus === "ACTIVE" && daysSinceCreated > 0;
    });

    const conversionTimes = converted
      .map((clinic) => {
        const createdAt = new Date(clinic.createdAt);
        const updatedAt = new Date(clinic.updatedAt);
        return Math.floor(
          (updatedAt.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24)
        );
      })
      .filter((days) => days > 0);

    const avgConversionTime =
      conversionTimes.length > 0
        ? Math.round(
            conversionTimes.reduce((a, b) => a + b, 0) / conversionTimes.length
          )
        : 0;

    const totalTrials = trials.length;
    const totalConverted = activeClinics.length;
    const conversionRate =
      totalTrials + totalConverted > 0
        ? Number(
            ((totalConverted / (totalTrials + totalConverted)) * 100).toFixed(2)
          )
        : 0;

    const byPlan = await db.clinic.groupBy({
      by: ["subscriptionPlan", "subscriptionStatus"],
      _count: { id: true },
    });

    const planConversion = byPlan.reduce(
      (acc, item) => {
        const plan = item.subscriptionPlan || "UNKNOWN";
        if (!acc[plan]) {
          acc[plan] = { trials: 0, active: 0 };
        }
        if (item.subscriptionStatus === "TRIAL") {
          acc[plan].trials = item._count.id;
        } else if (item.subscriptionStatus === "ACTIVE") {
          acc[plan].active = item._count.id;
        }
        return acc;
      },
      {} as Record<string, { trials: number; active: number }>
    );

    const byPlanData = Object.entries(planConversion).map(([plan, data]) => ({
      plan,
      conversionRate:
        data.trials + data.active > 0
          ? Number(
              ((data.active / (data.trials + data.active)) * 100).toFixed(2)
            )
          : 0,
      totalTrials: data.trials,
      totalActive: data.active,
    }));

    return c.json(
      {
        data: {
          conversionRate,
          totalTrials,
          totalConverted,
          avgConversionTime,
          byPlan: byPlanData,
        },
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getCustomerSuccess = async (c: Context) => {
  try {
    const thirtyDaysAgo = subDays(new Date(), 30);
    const sixMonthsAgo = subMonths(new Date(), 6);

    const activeClinics = await db.clinic.count({
      where: { subscriptionStatus: "ACTIVE" },
    });

    const clinicsWithRecentVisits = await db.clinic.count({
      where: {
        visits: {
          some: {
            createdAt: { gte: thirtyDaysAgo },
          },
        },
      },
    });

    const utilizationRate =
      activeClinics > 0
        ? Number(((clinicsWithRecentVisits / activeClinics) * 100).toFixed(2))
        : 0;

    const clinicStats = await db.clinic.findMany({
      where: {
        createdAt: { gte: sixMonthsAgo },
      },
      include: {
        _count: {
          select: {
            visits: true,
            patients: true,
            users: true,
          },
        },
        payments: {
          select: { amount: true },
        },
      },
    });

    const clinicMetrics = clinicStats.map((clinic) => ({
      clinicId: clinic.id,
      visits: clinic._count.visits,
      revenue: clinic.payments.reduce(
        (sum, payment) => sum + Number(payment.amount || 0),
        0
      ),
      monthsActive: Math.floor(
        (Date.now() - new Date(clinic.createdAt).getTime()) /
          (1000 * 60 * 60 * 24 * 30)
      ),
    }));

    const avgVisitsPerClinic =
      clinicMetrics.length > 0
        ? Number(
            (
              clinicMetrics.reduce(
                (sum, clinicMetric) => sum + clinicMetric.visits,
                0
              ) / clinicMetrics.length
            ).toFixed(2)
          )
        : 0;

    const avgRevenuePerClinic =
      clinicMetrics.length > 0
        ? Number(
            (
              clinicMetrics.reduce(
                (sum, clinicMetric) => sum + clinicMetric.revenue,
                0
              ) / clinicMetrics.length
            ).toFixed(2)
          )
        : 0;

    const clinicsWithGrowth = clinicMetrics.filter((clinicMetric) => {
      if (clinicMetric.monthsActive < 3) {
        return false;
      }
      return clinicMetric.visits > 0 && clinicMetric.revenue > 0;
    });

    const successRate =
      clinicMetrics.length > 0
        ? Number(
            ((clinicsWithGrowth.length / clinicMetrics.length) * 100).toFixed(2)
          )
        : 0;

    const patientPortalEnabled = await db.clinic.count({
      where: { isPatientPortalEnabled: true },
    });

    const featureAdoption = {
      patientPortal:
        activeClinics > 0
          ? Number(((patientPortalEnabled / activeClinics) * 100).toFixed(2))
          : 0,
    };

    return c.json(
      {
        data: {
          utilizationRate,
          avgVisitsPerClinic,
          avgRevenuePerClinic,
          successRate,
          adoptionMetrics: featureAdoption,
        },
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getDoctorStats = async (c: Context) => {
  try {
    const doctorId = Number(c.req.query("doctorId"));

    const doctor = await db.user.findUnique({ where: { id: doctorId } });
    if (!doctor) {
      return c.json(
        { error: "Doctor not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const now = new Date();
    const today = new Date(now.setHours(0, 0, 0, 0));
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const [currentDay, previousDay] = await Promise.all([
      db.$transaction([
        db.event.count({
          where: {
            doctorId,
            startTime: { gte: today },
            type: EventType.APPOINTMENT,
          },
        }),
        db.visit.count({
          where: {
            doctorId,
            status: VisitStatus.IN_CONSULTATION,
            createdAt: { gte: today },
          },
        }),
        db.visit.count({
          where: {
            doctorId,
            status: VisitStatus.DISCHARGED,
            createdAt: { gte: today },
          },
        }),
      ]),
      db.$transaction([
        db.event.count({
          where: {
            doctorId,
            startTime: { gte: yesterday, lt: today },
            type: EventType.APPOINTMENT,
          },
        }),
        db.visit.count({
          where: {
            doctorId,
            status: VisitStatus.IN_CONSULTATION,
            createdAt: { gte: yesterday, lt: today },
          },
        }),
        db.visit.count({
          where: {
            doctorId,
            status: VisitStatus.DISCHARGED,
            createdAt: { gte: yesterday, lt: today },
          },
        }),
      ]),
    ]);
    const appointmentsTrend = calculateTrend(currentDay[0], previousDay[0]);
    const pendingVisitsTrend = calculateTrend(currentDay[1], previousDay[1]);
    const completedVisitsTrend = calculateTrend(currentDay[2], previousDay[2]);

    return c.json(
      {
        data: {
          appointments: {
            count: currentDay[0],
            trend: appointmentsTrend,
            trendText: calculateTrendText(currentDay[0], previousDay[0]),
          },
          pendingVisits: {
            count: currentDay[1],
            trend: pendingVisitsTrend,
            trendText: calculateTrendText(currentDay[1], previousDay[1]),
          },
          completedVisits: {
            count: currentDay[2],
            trend: completedVisitsTrend,
            trendText: calculateTrendText(currentDay[2], previousDay[2]),
          },
        },
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getNurseStats = async (c: Context) => {
  try {
    const nurseId = Number(c.req.query("nurseId"));
    const nurse = await db.user.findUnique({ where: { id: nurseId } });
    if (!nurse) {
      return c.json(
        { error: "Nurse not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const now = new Date();
    const today = new Date(now.setHours(0, 0, 0, 0));
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const [currentDay, previousDay] = await Promise.all([
      db.$transaction([
        db.visit.count({
          where: { checkedInById: nurseId, createdAt: { gte: today } },
        }),
        db.visit.count({
          where: {
            checkedInById: nurseId,
            status: VisitStatus.CHECKED_IN,
            createdAt: { gte: today },
          },
        }),
        db.visit.count({
          where: {
            checkedInById: nurseId,
            status: VisitStatus.ADMITTED,
            createdAt: { gte: today },
          },
        }),
      ]),
      db.$transaction([
        db.visit.count({
          where: {
            checkedInById: nurseId,
            createdAt: { gte: yesterday, lt: today },
          },
        }),
        db.visit.count({
          where: {
            checkedInById: nurseId,
            status: VisitStatus.CHECKED_IN,
            createdAt: { gte: yesterday, lt: today },
          },
        }),
        db.visit.count({
          where: {
            checkedInById: nurseId,
            status: VisitStatus.ADMITTED,
            createdAt: { gte: yesterday, lt: today },
          },
        }),
      ]),
    ]);

    return c.json(
      {
        data: {
          checkins: {
            count: currentDay[0],
            trend: calculateTrend(currentDay[0], previousDay[0]),
            trendText: calculateTrendText(currentDay[0], previousDay[0]),
          },
          pendingConsultations: {
            count: currentDay[1],
            trend: calculateTrend(currentDay[1], previousDay[1]),
            trendText: calculateTrendText(currentDay[1], previousDay[1]),
          },
          hospitalizedPatients: {
            count: currentDay[2],
            trend: calculateTrend(currentDay[2], previousDay[2]),
            trendText: calculateTrendText(currentDay[2], previousDay[2]),
          },
        },
      },

      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getLabTechnicianStats = async (c: Context) => {
  try {
    const labTechnicianId = Number(c.req.query("labTechnicianId"));
    const labTechnician = await db.user.findUnique({
      where: { id: labTechnicianId },
      select: {
        clinicId: true,
      },
    });
    if (!labTechnician?.clinicId) {
      return c.json(
        { error: "Lab Technician not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const now = new Date();
    const today = new Date(now.setHours(0, 0, 0, 0));
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const [currentDay, previousDay] = await Promise.all([
      db.$transaction([
        db.exam.count({
          where: {
            clinicId: labTechnician.clinicId,
            createdAt: { gte: today },
          },
        }),
        db.exam.count({
          where: {
            clinicId: labTechnician.clinicId,
            status: ExamStatus.PENDING,
            createdAt: { gte: today },
          },
        }),
        db.exam.count({
          where: {
            clinicId: labTechnician.clinicId,
            status: ExamStatus.COMPLETED,
            createdAt: { gte: today },
          },
        }),
      ]),
      db.$transaction([
        db.exam.count({
          where: {
            clinicId: labTechnician.clinicId,
            createdAt: { gte: yesterday, lt: today },
          },
        }),
        db.exam.count({
          where: {
            clinicId: labTechnician.clinicId,
            status: ExamStatus.PENDING,
            createdAt: { gte: yesterday, lt: today },
          },
        }),
        db.exam.count({
          where: {
            clinicId: labTechnician.clinicId,
            status: ExamStatus.COMPLETED,
            createdAt: { gte: yesterday, lt: today },
          },
        }),
      ]),
    ]);
    return c.json(
      {
        data: {
          totalExams: {
            count: currentDay[0],
            trend: calculateTrend(currentDay[0], previousDay[0]),
            trendText: calculateTrendText(currentDay[0], previousDay[0]),
          },
          pendingExams: {
            count: currentDay[1],
            trend: calculateTrend(currentDay[1], previousDay[1]),
            trendText: calculateTrendText(currentDay[1], previousDay[1]),
          },
          completedExams: {
            count: currentDay[2],
            trend: calculateTrend(currentDay[2], previousDay[2]),
            trendText: calculateTrendText(currentDay[2], previousDay[2]),
          },
        },
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getAccountantStats = async (c: Context) => {
  try {
    const accountantId = Number(c.req.query("accountantId"));
    const accountant = await db.user.findUnique({
      where: { id: accountantId },
    });
    if (!accountant) {
      return c.json(
        { error: "Accountant not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const now = new Date();
    const today = new Date(now.setHours(0, 0, 0, 0));
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const [currentDay, previousDay] = await Promise.all([
      db.$transaction([
        db.payment.aggregate({
          _sum: { amount: true },
          where: { createdAt: { gte: today } },
        }),
        db.payment.count({
          where: {
            createdAt: { gte: today },
            paymentStatus: PaymentStatus.PENDING,
          },
        }),
        db.payment.count({
          where: {
            createdAt: { gte: today },
            paymentStatus: PaymentStatus.PAID,
          },
        }),
        db.payment.aggregate({
          _sum: { insuranceAmount: true },
          where: {
            createdAt: { gte: today },
            paymentMode: PaymentMode.INSURANCE,
          },
        }),
      ]),
      db.$transaction([
        db.payment.aggregate({
          _sum: { amount: true },
          where: { createdAt: { gte: yesterday, lt: today } },
        }),
        db.payment.count({
          where: {
            createdAt: { gte: yesterday, lt: today },
            paymentStatus: PaymentStatus.PENDING,
          },
        }),
        db.payment.count({
          where: {
            createdAt: { gte: yesterday, lt: today },
            paymentStatus: PaymentStatus.PAID,
          },
        }),
        db.payment.aggregate({
          _sum: { insuranceAmount: true },
          where: {
            createdAt: { gte: yesterday, lt: today },
            paymentMode: PaymentMode.INSURANCE,
          },
        }),
      ]),
    ]);
    return c.json(
      {
        data: {
          totalRevenue: {
            count: currentDay[0]._sum.amount || 0,
            trend: calculateTrend(
              Number(currentDay[0]._sum.amount || 0),
              Number(previousDay[0]._sum.amount || 0)
            ),
            trendText: calculateTrendText(
              Number(currentDay[0]._sum.amount || 0),
              Number(previousDay[0]._sum.amount || 0)
            ),
          },
          pendingPayments: {
            count: currentDay[1],
            trend: calculateTrend(currentDay[1], previousDay[1]),
            trendText: calculateTrendText(currentDay[1], previousDay[1]),
          },
          completedPayments: {
            count: currentDay[2],
            trend: calculateTrend(currentDay[2], previousDay[2]),
            trendText: calculateTrendText(currentDay[2], previousDay[2]),
          },
          insuranceClaims: {
            count: currentDay[3]._sum.insuranceAmount || 0,
            trend: calculateTrend(
              Number(currentDay[3]._sum.insuranceAmount || 0),
              Number(previousDay[3]._sum.insuranceAmount || 0)
            ),
            trendText: calculateTrendText(
              Number(currentDay[3]._sum.insuranceAmount || 0),
              Number(previousDay[3]._sum.insuranceAmount || 0)
            ),
          },
        },
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getStockManagerStats = async (c: Context) => {
  try {
    const stockManagerId = Number(c.req.query("stockManagerId"));
    const stockManager = await db.user.findUnique({
      where: { id: stockManagerId },
    });
    if (!stockManager) {
      return c.json(
        { error: "Stock Manager not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (!stockManager.clinicId) {
      return c.json(
        { error: "Stock Manager not associated with a clinic" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    const now = new Date();
    const today = new Date(now.setHours(0, 0, 0, 0));
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const thirtyDaysFromNow = new Date(today);
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

    const [currentDay, previousDay] = await Promise.all([
      // Total items count
      db.$transaction([
        db.inventoryItem.count({ where: { clinicId: stockManager.clinicId } }),
        // Low stock items count
        db.inventoryItem.count({
          where: {
            clinicId: stockManager.clinicId,
            status: InventoryStatus.LOW_STOCK,
          },
        }),
        // Items nearing expiration
        db.inventoryBatch.count({
          where: {
            item: { clinicId: stockManager.clinicId },
            expiryDate: { lte: thirtyDaysFromNow, gte: today },
          },
        }),
        // Recent transactions count
        db.transaction.count({
          where: {
            item: { clinicId: stockManager.clinicId },
            createdAt: { gte: today },
          },
        }),
        // Total inventory value
        db.inventoryStock.aggregate({
          _sum: { quantity: true },
          where: { item: { clinicId: stockManager.clinicId } },
        }),
      ]),
      db.$transaction([
        // Previous day's total items
        db.inventoryItem.count({
          where: {
            clinicId: stockManager.clinicId,
            createdAt: { gte: yesterday, lt: today },
          },
        }),
        // Previous day's low stock items
        db.inventoryItem.count({
          where: {
            clinicId: stockManager.clinicId,
            status: InventoryStatus.LOW_STOCK,
            createdAt: { gte: yesterday, lt: today },
          },
        }),
        // Previous day's items nearing expiration
        db.inventoryBatch.count({
          where: {
            item: { clinicId: stockManager.clinicId },
            createdAt: { gte: yesterday, lt: today },
            expiryDate: { lte: thirtyDaysFromNow, gte: today },
          },
        }),
        // Previous day's transactions
        db.transaction.count({
          where: {
            item: { clinicId: stockManager.clinicId },
            createdAt: { gte: yesterday, lt: today },
          },
        }),
        // Previous day's total inventory value
        db.inventoryStock.aggregate({
          _sum: { quantity: true },
          where: {
            item: {
              clinicId: stockManager.clinicId,
            },
          },
        }),
      ]),
    ]);
    return c.json(
      {
        data: {
          totalItems: {
            count: currentDay[0],
            trend: calculateTrend(currentDay[0], previousDay[0]),
            trendText: calculateTrendText(currentDay[0], previousDay[0]),
          },
          lowStockItems: {
            count: currentDay[1],
            trend: calculateTrend(currentDay[1], previousDay[1]),
            trendText: calculateTrendText(currentDay[1], previousDay[1]),
          },
          expiringItems: {
            count: currentDay[2],
            trend: calculateTrend(currentDay[2], previousDay[2]),
            trendText: calculateTrendText(currentDay[2], previousDay[2]),
          },
          recentTransactions: {
            count: currentDay[3],
            trend: calculateTrend(currentDay[3], previousDay[3]),
            trendText: calculateTrendText(currentDay[3], previousDay[3]),
          },
          totalValue: {
            count: currentDay[4]._sum.quantity || 0,
            trend: calculateTrend(
              currentDay[4]._sum.quantity || 0,
              previousDay[4]._sum.quantity || 0
            ),
            trendText: calculateTrendText(
              currentDay[4]._sum.quantity || 0,
              previousDay[4]._sum.quantity || 0
            ),
          },
        },
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
