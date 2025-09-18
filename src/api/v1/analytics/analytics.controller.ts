import type { Decimal } from "@prisma/client/runtime/library";
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
import { httpCodes } from "@/lib/constants";
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
    const user = c.get("user");
    const now = new Date();
    const today = new Date(now.setHours(0, 0, 0, 0));
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const [currentDay, previousDay] = await Promise.all([
      db.$transaction([
        db.payment.count({
          where: { createdAt: { gte: today }, clinicId: user.clinic.id },
        }),
        db.visit.count({
          where: { createdAt: { gte: today }, clinicId: user.clinic.id },
        }),
        db.event.count({
          where: {
            type: "APPOINTMENT",
            createdAt: { gte: today },
            clinicId: user.clinic.id,
          },
        }),
        db.payment.aggregate({
          _sum: { amount: true },
          where: { createdAt: { gte: today }, clinicId: user.clinic.id },
        }),
      ]),
      db.$transaction([
        db.payment.count({
          where: {
            createdAt: { gte: yesterday, lt: today },
            clinicId: user.clinic.id,
          },
        }),
        db.visit.count({
          where: {
            createdAt: { gte: yesterday, lt: today },
            clinicId: user.clinic.id,
          },
        }),
        db.event.count({
          where: {
            type: "APPOINTMENT",
            createdAt: { gte: yesterday, lt: today },
            clinicId: user.clinic.id,
          },
        }),
        db.payment.aggregate({
          _sum: { amount: true },
          where: {
            createdAt: { gte: yesterday, lt: today },
            clinicId: user.clinic.id,
          },
        }),
      ]),
    ]);

    const calculateTrend = (current: number, previous: number) => {
      if (!previous) {
        return 100;
      }
      return ((current - previous) / previous) * 100;
    };
    const calculateTrendText = (current: number, previous: number) => {
      const t = calculateTrend(current, previous);
      return `${t >= 0 ? "+" : ""}${t.toFixed(1)}%`;
    };

    return c.json({
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
    });
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
    const user = c.get("user");
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
            clinicId: user.clinic.id,
            doctorId: doctorId ? Number(doctorId) : undefined,
          },
        },
      },
      select: {
        dateOfBirth: true,
        visits: {
          where: { createdAt: { gte: startDate }, clinicId: user.clinic.id },
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
    return c.json({ data: result });
  } catch (_error) {
    return c.json({ error: "Internal Server Error" }, 500);
  }
};

// Frontend parity: getCashFlow
export const getCashFlow = async (c: Context) => {
  try {
    const user = c.get("user");
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
      getDataForRange(startDate, endDate, user.clinic.id),
      getDataForRange(previousStartDate, startDate, user.clinic.id),
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

    return c.json({
      data: {
        monthlyData,
        totalIncome: currentData.totalIncome,
        totalExpenses: currentData.totalExpenses,
        totalCashFlow,
        trend: calculateTrend(totalCashFlow, previousTotalCashFlow),
        trendText: calculateTrendText(totalCashFlow, previousTotalCashFlow),
      },
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

const calculateTrend = (current: number, previous: number) => {
  if (!previous) {
    return 100;
  }
  return ((current - previous) / previous) * 100;
};
const calculateTrendText = (current: number, previous: number) => {
  const t = calculateTrend(current, previous);
  return `${t >= 0 ? "+" : ""}${t.toFixed(1)}%`;
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
    }: { createdAt: Date; _sum: { amount: Decimal | null } } = item;
    const monthKey = format(createdAt, "MMM");
    monthlyIncome[monthKey] =
      (monthlyIncome[monthKey] || 0) + Number(_sum.amount || 0);
    totalIncome += Number(_sum.amount || 0);
  }
  for (const item of discountData) {
    const {
      createdAt,
      _sum,
    }: { createdAt: Date; _sum: { amount: Decimal | null } } = item;
    const monthKey = format(createdAt, "MMM");
    monthlyIncome[monthKey] =
      (monthlyIncome[monthKey] || 0) - Number(_sum.amount || 0);
    totalIncome -= Number(_sum.amount || 0);
  }
  for (const item of expenseData) {
    const {
      createdAt,
      _sum,
    }: { createdAt: Date; _sum: { amount: Decimal | null } } = item;
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
    const user = c.get("user");
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
        clinicId: user.clinic.id,
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
    return c.json({ data: top5 });
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

    const [currentDay, previousDay] = await Promise.all([
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
    ]);

    return c.json({
      data: {
        totalClinics: {
          count: currentDay[0],
          trend: calculateTrend(currentDay[0], previousDay[0]),
          trendText: calculateTrendText(currentDay[0], previousDay[0]),
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
    });
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
    return c.json({
      data: clinics.map(
        (clinic: {
          subscriptionPlan: string | null;
          _count: { id: number };
        }) => ({ plan: clinic.subscriptionPlan, count: clinic._count.id })
      ),
    });
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
    return c.json({ data });
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
    return c.json({ data });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
