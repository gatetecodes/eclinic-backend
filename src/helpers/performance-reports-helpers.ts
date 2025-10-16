import {
  differenceInCalendarDays,
  endOfDay,
  endOfMonth,
  endOfQuarter,
  endOfWeek,
  endOfYear,
  startOfDay,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
  subDays,
  subMonths,
  subQuarters,
  subWeeks,
  subYears,
} from "date-fns";
import { PaymentStatus, Role, VisitStatus } from "../../generated/prisma";
import { db } from "../database/db";
import type {
  PerformanceDateRange,
  PerformanceFilters,
} from "../types/performance.types";

export const getDateRanges = (
  dateRange: PerformanceDateRange,
  filters?: PerformanceFilters
) => {
  const now = new Date();
  let startDate: Date, endDate: Date;
  let prevStartDate: Date, prevEndDate: Date;

  // If custom date range is specified in filters, use those
  if (dateRange === "custom" && !!filters?.startDate && !!filters?.endDate) {
    startDate = startOfDay(new Date(filters.startDate));
    endDate = endOfDay(new Date(filters.endDate));

    // Compute previous period using calendar-day math to preserve whole days
    const periodDays = differenceInCalendarDays(endDate, startDate) + 1;
    prevEndDate = endOfDay(subDays(startDate, 1));
    prevStartDate = startOfDay(subDays(startDate, periodDays));
  } else {
    // Use existing logic for predefined ranges
    switch (dateRange as PerformanceDateRange) {
      case "today":
        startDate = startOfDay(now);
        endDate = endOfDay(now);
        prevStartDate = startOfDay(subDays(now, 1));
        prevEndDate = endOfDay(subDays(now, 1));
        break;
      case "week":
        startDate = startOfWeek(now);
        endDate = endOfWeek(now);
        prevStartDate = startOfWeek(subWeeks(now, 1));
        prevEndDate = endOfWeek(subWeeks(now, 1));
        break;
      case "month":
        startDate = startOfMonth(now);
        endDate = endOfMonth(now);
        prevStartDate = startOfMonth(subMonths(now, 1));
        prevEndDate = endOfMonth(subMonths(now, 1));
        break;
      case "quarter":
        startDate = startOfQuarter(now);
        endDate = endOfQuarter(now);
        prevStartDate = startOfQuarter(subQuarters(now, 1));
        prevEndDate = endOfQuarter(subQuarters(now, 1));
        break;
      case "year":
        startDate = startOfYear(now);
        endDate = endOfYear(now);
        prevStartDate = startOfYear(subYears(now, 1));
        prevEndDate = endOfYear(subYears(now, 1));
        break;
      default:
        startDate = startOfMonth(now);
        endDate = endOfMonth(now);
        prevStartDate = startOfMonth(subMonths(now, 1));
        prevEndDate = endOfMonth(subMonths(now, 1));
        break;
    }
  }

  return { startDate, endDate, prevStartDate, prevEndDate };
};

export const getContextualTrendText = (
  current: number,
  previous: number,
  dateRange: PerformanceDateRange
): string => {
  const currentValue = Number(current) || 0;
  const previousValue = Number(previous) || 0;

  if (currentValue === previousValue) {
    switch (dateRange as PerformanceDateRange) {
      case "today":
        return "Same as yesterday";
      case "week":
        return "Same as last week";
      case "month":
        return "Same as last month";
      case "quarter":
        return "Same as last quarter";
      case "year":
        return "Same as last year";
      default:
        return "Same as previous period";
    }
  }

  const difference = Math.abs(currentValue - previousValue);
  const direction = currentValue > previousValue ? "more than" : "less than";
  let period = "";
  switch (dateRange as PerformanceDateRange) {
    case "today":
      period = "yesterday";
      break;
    case "week":
      period = "last week";
      break;
    case "month":
      period = "last month";
      break;
    case "quarter":
      period = "last quarter";
      break;
    case "year":
      period = "last year";
      break;
    default:
      period = "previous period";
      break;
  }

  return `${difference} ${direction} ${period}`;
};

export const getDoctorMetricsForPeriod = async ({
  doctorId,
  startDate,
  endDate,
  clinicId,
}: {
  doctorId: number;
  startDate: Date;
  endDate: Date;
  clinicId: number;
}) => {
  const [totalVisits, completedVisits, revenue, examOrders, treatmentOrders] =
    await db.$transaction([
      db.visit.count({
        where: {
          doctorId,
          clinicId,
          createdAt: { gte: startDate, lte: endDate },
        },
      }),
      db.visit.count({
        where: {
          doctorId,
          clinicId,
          createdAt: { gte: startDate, lte: endDate },
          status: {
            in: [
              VisitStatus.DISCHARGED,
              VisitStatus.DISCHARGED_WITH_PRESCRIPTION,
              VisitStatus.FINALIZED,
            ],
          },
        },
      }),
      db.payment.aggregate({
        _sum: { amount: true },
        where: {
          clinicId,
          createdAt: { gte: startDate, lte: endDate },
          paymentStatus: { in: [PaymentStatus.PAID, PaymentStatus.FULLY_PAID] },
          visit: { doctorId },
        },
      }),
      db.exam.count({
        where: {
          visit: {
            doctorId,
            clinicId,
            createdAt: { gte: startDate, lte: endDate },
          },
        },
      }),
      db.treatment.count({
        where: {
          visit: {
            doctorId,
            clinicId,
            createdAt: { gte: startDate, lte: endDate },
          },
        },
      }),
    ]);

  return {
    totalVisits,
    completedVisits,
    totalRevenue: Number(revenue._sum.amount || 0),
    examOrders,
    treatmentOrders,
  };
};

/**
 * Helper function to get staff metrics for a specific period
 */
export const getStaffMetricsForPeriod = async ({
  staffId,
  role,
  startDate,
  endDate,
  clinicId,
}: {
  staffId: number;
  role: Role;
  startDate: Date;
  endDate: Date;
  clinicId: number;
}) => {
  const baseMetrics: {
    name: string;
    count: number;
    type: "service" | "revenue";
  }[] = [];

  switch (role) {
    case Role.NURSE: {
      const [checkins, triageCompleted, admissions] = await db.$transaction([
        db.visit.count({
          where: {
            checkedInById: staffId,
            clinicId,
            createdAt: { gte: startDate, lte: endDate },
          },
        }),
        db.visit.count({
          where: {
            checkedInById: staffId,
            clinicId,
            status: VisitStatus.TRIAGE_COMPLETED,
            createdAt: { gte: startDate, lte: endDate },
          },
        }),
        db.visit.count({
          where: {
            checkedInById: staffId,
            clinicId,
            status: VisitStatus.ADMITTED,
            createdAt: { gte: startDate, lte: endDate },
          },
        }),
      ]);

      baseMetrics.push(
        { name: "Patient Check-ins", count: checkins, type: "service" },
        { name: "Triage Completed", count: triageCompleted, type: "service" },
        { name: "Patient Admissions", count: admissions, type: "service" }
      );
      break;
    }
    case Role.LAB_TECHNICIAN: {
      const [testsCompleted, pendingTests] = await db.$transaction([
        db.examResult.count({
          where: {
            createdById: staffId,
            createdAt: { gte: startDate, lte: endDate },
          },
        }),
        db.exam.count({
          where: {
            visit: { clinicId },
            status: "PENDING",
            createdAt: { gte: startDate, lte: endDate },
          },
        }),
      ]);

      baseMetrics.push(
        { name: "Tests Completed", count: testsCompleted, type: "service" },
        { name: "Pending Tests", count: pendingTests, type: "service" }
      );
      break;
    }
    case Role.CASHIER: {
      const [paymentsProcessed, revenueProcessed] = await db.$transaction([
        db.payment.count({
          where: {
            processedById: staffId,
            clinicId,
            createdAt: { gte: startDate, lte: endDate },
          },
        }),
        db.payment.aggregate({
          _sum: { amount: true },
          where: {
            processedById: staffId,
            clinicId,
            createdAt: { gte: startDate, lte: endDate },
            paymentStatus: {
              in: [PaymentStatus.PAID, PaymentStatus.FULLY_PAID],
            },
          },
        }),
      ]);

      baseMetrics.push(
        {
          name: "Payments Processed",
          count: paymentsProcessed,
          type: "service",
        },
        {
          name: "Revenue Processed",
          count: Number(revenueProcessed._sum.amount || 0),
          type: "revenue",
        }
      );
      break;
    }
    default: {
      // For other roles, get activity log counts
      const activities = await db.activityLog.count({
        where: {
          userId: staffId,
          timestamp: { gte: startDate, lte: endDate },
        },
      });

      baseMetrics.push({
        name: "Activities Logged",
        count: activities,
        type: "service",
      });
    }
  }

  return baseMetrics;
};
