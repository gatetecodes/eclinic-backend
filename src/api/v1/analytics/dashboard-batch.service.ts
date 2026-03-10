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
import { calculateTrend, calculateTrendText } from "@/helpers/analytics-helper";
import {
  EventType,
  ExamStatus,
  InventoryStatus,
  PaymentMode,
  PaymentStatus,
  type Prisma,
  VisitStatus,
} from "../../../../generated/prisma/client";
import { db } from "../../../database/db";

const MONTHS_IN_6_MONTHS = 6;
const MONTHS_IN_3_MONTHS = 3;

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

export async function fetchDashboardOverview(clinicId: number) {
  const now = new Date();
  const today = new Date(now.setHours(0, 0, 0, 0));
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const [currentDay, previousDay] = await Promise.all([
    db.$transaction([
      db.payment.count({ where: { createdAt: { gte: today }, clinicId } }),
      db.visit.count({ where: { createdAt: { gte: today }, clinicId } }),
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
        where: { createdAt: { gte: yesterday, lt: today }, clinicId },
      }),
      db.visit.count({
        where: { createdAt: { gte: yesterday, lt: today }, clinicId },
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

  return {
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
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: dashboard batch logic
export async function fetchPatientsByAge(
  clinicId: number,
  timeRange: "week" | "month" | "3months",
  doctorId: number | null
) {
  const now = new Date();
  let startDate: Date;
  // biome-ignore lint/nursery/noUnnecessaryConditions: switch discriminant is a non-null union; rule misflags valid pattern
  switch (timeRange) {
    case "week":
      startDate = subWeeks(now, 1);
      break;
    case "month":
      startDate = subMonths(now, 1);
      break;
    default:
      startDate = subMonths(now, MONTHS_IN_3_MONTHS);
      break;
  }

  const patients = await db.patient.findMany({
    where: {
      visits: {
        some: {
          createdAt: { gte: startDate },
          clinicId,
          doctorId: doctorId ?? undefined,
        },
      },
    },
    select: {
      dateOfBirth: true,
      visits: {
        where: {
          createdAt: { gte: startDate },
          clinicId,
          doctorId: doctorId ?? undefined,
        },
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
        if (age !== undefined && age < 18) {
          dailyGroups[visitDate].child++;
        } else if (age !== undefined && age >= 18 && age <= 65) {
          dailyGroups[visitDate].adult++;
        } else {
          dailyGroups[visitDate].elderly++;
        }
      }
    }
  }

  return Object.entries(dailyGroups).map(([date, groups]) => ({
    date,
    child: groups.child,
    adult: groups.adult,
    elderly: groups.elderly,
  }));
}

export async function fetchCashFlow(
  clinicId: number,
  timeRange: "year" | "6months" | "3months"
) {
  const now = new Date();
  let startDate: Date;
  let previousStartDate: Date;
  let previousEndDate: Date;

  // biome-ignore lint/nursery/noUnnecessaryConditions: switch on exhaustive union is valid, not a truthiness check
  switch (timeRange) {
    case "year":
      startDate = startOfYear(now);
      previousStartDate = subYears(startDate, 1);
      previousEndDate = subYears(now, 1);
      break;
    case "6months":
      startDate = subMonths(now, MONTHS_IN_6_MONTHS);
      previousStartDate = subMonths(startDate, MONTHS_IN_6_MONTHS);
      previousEndDate = startDate;
      break;
    default:
      startDate = subMonths(now, MONTHS_IN_3_MONTHS);
      previousStartDate = subMonths(startDate, MONTHS_IN_3_MONTHS);
      previousEndDate = startDate;
      break;
  }

  const endDate = now;
  const chartEndDate = timeRange === "year" ? endOfYear(now) : endDate;

  const [currentData, previousData] = await Promise.all([
    getDataForRange(startDate, endDate, clinicId),
    getDataForRange(previousStartDate, previousEndDate, clinicId),
  ]);

  const monthlyData = eachMonthOfInterval({
    start: startDate,
    end: chartEndDate,
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

  return {
    monthlyData,
    totalIncome: currentData.totalIncome,
    totalExpenses: currentData.totalExpenses,
    totalCashFlow,
    trend: calculateTrend(totalCashFlow, previousTotalCashFlow),
    trendText: calculateTrendText(totalCashFlow, previousTotalCashFlow),
  };
}

export async function fetchVisitsByDepartments(
  clinicId: number,
  userId: number | null
) {
  const visits = await db.visit.groupBy({
    by: ["departmentId"],
    where: {
      doctorId: userId ?? undefined,
      clinicId,
    },
    _count: { id: true },
  });

  const data: { departmentName: string; count: number }[] = [];

  for (const visit of visits) {
    if (!visit.departmentId) {
      data.push({ departmentName: "No department", count: visit._count.id });
      continue;
    }
    const dept = await db.clinicalDepartment.findUnique({
      where: { id: visit.departmentId },
      select: { name: true },
    });
    data.push({
      departmentName: dept?.name ?? "Unknown",
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
  return top5;
}

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
  VisitStatus.CHECKED_IN,
  VisitStatus.IN_CONSULTATION,
  VisitStatus.PENDING_TESTS,
  VisitStatus.DISCHARGED,
  VisitStatus.ADMITTED,
];

export async function fetchImportantStatusesVisitsCount(clinicId: number) {
  const now = new Date();
  const startDate = startOfDay(now);
  const endDate = endOfDay(now);

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

  return { totalVisits, currentDataByStatus };
}

export async function fetchDoctorStats(doctorId: number) {
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

  return {
    appointments: {
      count: currentDay[0],
      trend: calculateTrend(currentDay[0], previousDay[0]),
      trendText: calculateTrendText(currentDay[0], previousDay[0]),
    },
    pendingVisits: {
      count: currentDay[1],
      trend: calculateTrend(currentDay[1], previousDay[1]),
      trendText: calculateTrendText(currentDay[1], previousDay[1]),
    },
    completedVisits: {
      count: currentDay[2],
      trend: calculateTrend(currentDay[2], previousDay[2]),
      trendText: calculateTrendText(currentDay[2], previousDay[2]),
    },
  };
}

export async function fetchNurseStats(nurseId: number) {
  const now = new Date();
  const today = startOfDay(now);
  const yesterday = startOfDay(subDays(now, 1));

  const [currentDay, previousDay, triagedTodayCount] = await Promise.all([
    db.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: nurseId },
        select: { clinicId: true },
      });
      const clinicId = user?.clinicId;
      if (!clinicId) {
        throw new Error("Clinic ID not found for nurse");
      }

      return [
        await tx.visit.count({
          where: { clinicId, status: VisitStatus.CHECKED_IN },
        }),
        await tx.visit.count({
          where: {
            status: {
              in: [
                VisitStatus.TRIAGE_COMPLETED,
                VisitStatus.IN_PRE_CONSULTATION,
                VisitStatus.IN_CONSULTATION,
              ],
            },
          },
        }),
        await tx.visit.count({
          where: {
            status: VisitStatus.ADMITTED,
          },
        }),
      ];
    }),
    db.$transaction([
      db.visit.count({
        where: {
          createdAt: { gte: yesterday, lt: today },
          status: VisitStatus.CHECKED_IN,
        },
      }),
      db.visit.count({
        where: {
          createdAt: { gte: yesterday, lt: today },
          status: {
            in: [
              VisitStatus.TRIAGE_COMPLETED,
              VisitStatus.IN_PRE_CONSULTATION,
              VisitStatus.IN_CONSULTATION,
            ],
          },
        },
      }),
      db.visit.count({
        where: {
          createdAt: { gte: yesterday, lt: today },
          status: VisitStatus.ADMITTED,
        },
      }),
    ]),
    db.visit.count({
      where: {
        checkedInById: nurseId,
        createdAt: { gte: today },
      },
    }),
  ]);

  return {
    waitingForTriage: {
      count: currentDay[0],
      trend: calculateTrend(currentDay[0], previousDay[0]),
      trendText: calculateTrendText(currentDay[0], previousDay[0]),
    },
    inProgress: {
      count: currentDay[1],
      trend: calculateTrend(currentDay[1], previousDay[1]),
      trendText: calculateTrendText(currentDay[1], previousDay[1]),
    },
    hospitalizedPatients: {
      count: currentDay[2],
      trend: calculateTrend(currentDay[2], previousDay[2]),
      trendText: calculateTrendText(currentDay[2], previousDay[2]),
    },
    triagedToday: {
      count: triagedTodayCount,
    },
  };
}

export async function fetchLabTechnicianStats(labTechnicianId: number) {
  const labTechnician = await db.user.findUnique({
    where: { id: labTechnicianId },
    select: { clinicId: true },
  });
  if (!labTechnician?.clinicId) {
    throw new Error("Lab Technician not found");
  }
  const clinicId = labTechnician.clinicId;

  const now = new Date();
  const today = new Date(now.setHours(0, 0, 0, 0));
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const [currentDay, previousDay] = await Promise.all([
    db.$transaction([
      db.exam.count({
        where: { clinicId, createdAt: { gte: today } },
      }),
      db.exam.count({
        where: {
          clinicId,
          status: ExamStatus.PENDING,
          createdAt: { gte: today },
        },
      }),
      db.exam.count({
        where: {
          clinicId,
          status: ExamStatus.COMPLETED,
          createdAt: { gte: today },
        },
      }),
    ]),
    db.$transaction([
      db.exam.count({
        where: { clinicId, createdAt: { gte: yesterday, lt: today } },
      }),
      db.exam.count({
        where: {
          clinicId,
          status: ExamStatus.PENDING,
          createdAt: { gte: yesterday, lt: today },
        },
      }),
      db.exam.count({
        where: {
          clinicId,
          status: ExamStatus.COMPLETED,
          createdAt: { gte: yesterday, lt: today },
        },
      }),
    ]),
  ]);

  return {
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
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: dashboard batch logic
export async function fetchAccountantStats(accountantId: number) {
  const accountant = await db.user.findUnique({
    where: { id: accountantId },
    select: { clinicId: true },
  });
  if (!accountant?.clinicId) {
    throw new Error("Accountant not found");
  }
  const clinicId = accountant.clinicId;

  const now = new Date();
  const today = startOfDay(now);
  const yesterday = startOfDay(subDays(now, 1));

  const [currentDay, previousDay, paymentsToday] = await Promise.all([
    db.$transaction([
      db.payment.aggregate({
        _sum: { amount: true },
        where: { createdAt: { gte: today }, clinicId },
      }),
      db.payment.count({
        where: {
          createdAt: { gte: today },
          paymentStatus: PaymentStatus.PENDING,
          clinicId,
        },
      }),
      db.payment.count({
        where: {
          createdAt: { gte: today },
          paymentStatus: {
            in: [PaymentStatus.PAID, PaymentStatus.FULLY_PAID],
          },
          clinicId,
        },
      }),
      db.payment.aggregate({
        _sum: { insuranceAmount: true },
        where: {
          createdAt: { gte: today },
          paymentMode: PaymentMode.INSURANCE,
          clinicId,
        },
      }),
    ]),
    db.$transaction([
      db.payment.aggregate({
        _sum: { amount: true },
        where: { createdAt: { gte: yesterday, lt: today }, clinicId },
      }),
      db.payment.count({
        where: {
          createdAt: { gte: yesterday, lt: today },
          paymentStatus: PaymentStatus.PENDING,
          clinicId,
        },
      }),
      db.payment.count({
        where: {
          createdAt: { gte: yesterday, lt: today },
          paymentStatus: {
            in: [PaymentStatus.PAID, PaymentStatus.FULLY_PAID],
          },
          clinicId,
        },
      }),
      db.payment.aggregate({
        _sum: { insuranceAmount: true },
        where: {
          createdAt: { gte: yesterday, lt: today },
          paymentMode: PaymentMode.INSURANCE,
          clinicId,
        },
      }),
    ]),
    db.payment.findMany({
      where: { createdAt: { gte: today }, clinicId },
      select: {
        amount: true,
        paymentMode: true,
        visit: {
          select: {
            patientInsurance: {
              select: {
                insuranceCompany: {
                  select: {
                    companyName: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  const distributionMap: Record<string, number> = {};
  for (const p of paymentsToday) {
    let mode = p.paymentMode as string;
    if (mode === "INSURANCE") {
      const insuranceName =
        p.visit?.patientInsurance?.insuranceCompany?.companyName;
      mode = insuranceName ?? "Insurance";
    }
    distributionMap[mode] = (distributionMap[mode] || 0) + Number(p.amount);
  }

  const paymentModeDistribution = Object.entries(distributionMap).map(
    ([mode, amount]) => ({ mode, amount })
  );

  return {
    totalRevenue: {
      count: Number(currentDay[0]._sum.amount || 0),
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
      count: Number(currentDay[3]._sum.insuranceAmount || 0),
      trend: calculateTrend(
        Number(currentDay[3]._sum.insuranceAmount || 0),
        Number(previousDay[3]._sum.insuranceAmount || 0)
      ),
      trendText: calculateTrendText(
        Number(currentDay[3]._sum.insuranceAmount || 0),
        Number(previousDay[3]._sum.insuranceAmount || 0)
      ),
    },
    todayRevenue: { count: Number(currentDay[0]._sum.amount || 0) },
    paymentModeDistribution,
  };
}

export async function fetchStockManagerStats(stockManagerId: number) {
  const stockManager = await db.user.findUnique({
    where: { id: stockManagerId },
  });
  if (!stockManager?.clinicId) {
    throw new Error("Stock Manager not found");
  }
  const clinicId = stockManager.clinicId;

  const now = new Date();
  const today = new Date(now.setHours(0, 0, 0, 0));
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const thirtyDaysFromNow = new Date(today);
  thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

  const [currentDay, previousDayCount] = await Promise.all([
    db.$transaction([
      db.inventoryItem.count({ where: { clinicId } }),
      db.inventoryItem.count({
        where: { clinicId, status: InventoryStatus.LOW_STOCK },
      }),
      db.inventoryBatch.count({
        where: {
          item: { clinicId },
          expiryDate: { lte: thirtyDaysFromNow, gte: today },
        },
      }),
      db.transaction.count({
        where: { item: { clinicId }, createdAt: { gte: today } },
      }),
      db.inventoryStock.aggregate({
        _sum: { quantity: true },
        where: { item: { clinicId } },
      }),
    ]),
    db.transaction.count({
      where: {
        item: { clinicId },
        createdAt: { gte: yesterday, lt: today },
      },
    }),
  ]);

  return {
    totalItems: {
      count: currentDay[0],
    },
    lowStockItems: {
      count: currentDay[1],
    },
    expiringItems: {
      count: currentDay[2],
    },
    recentTransactions: {
      count: currentDay[3],
      trend: calculateTrend(currentDay[3], previousDayCount),
      trendText: calculateTrendText(currentDay[3], previousDayCount),
    },
    totalValue: {
      count: currentDay[4]._sum.quantity || 0,
    },
  };
}
