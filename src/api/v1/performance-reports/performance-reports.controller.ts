import { endOfDay, format, startOfDay } from "date-fns";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { calculateTrend, calculateTrendText } from "@/helpers/analytics-helper";
import type { Prisma } from "../../../../generated/prisma";
import {
  PaymentStatus,
  Role,
  UserStatus,
  VisitStatus,
} from "../../../../generated/prisma";
import { db } from "../../../database/db";
import {
  getClinicDepartmentsForFilter,
  getClinicDoctorsForFilter,
  getClinicStaffRolesForFilter,
  getContextualTrendText,
  getDateRanges,
  getDoctorMetricsForPeriod,
  getStaffMetricsForPeriod,
} from "../../../helpers/performance-reports-helpers";
import { httpCodes } from "../../../lib/constants";

/**
 * Get performance overview for a specific clinic and date range
 */
//biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
export const getPerformanceOverview = async (c: Context) => {
  try {
    const user = c.get("user");

    const query = c.get("validatedQuery");
    const { dateRange, filters } = query;
    const { startDate, endDate, prevStartDate, prevEndDate } = getDateRanges(
      dateRange,
      filters
    );
    const [currentPeriod, previousPeriod] = await Promise.all([
      db.$transaction([
        // Total visits
        db.visit.count({
          where: {
            clinicId: user.clinicId,
            createdAt: { gte: startDate, lte: endDate },
            doctorId: filters?.doctorId ? Number(filters.doctorId) : undefined,
            departmentId: filters?.departmentId
              ? Number(filters.departmentId)
              : undefined,
          },
        }),
        // Total revenue
        db.payment.aggregate({
          _sum: { amount: true },
          where: {
            clinicId: user.clinicId,
            createdAt: { gte: startDate, lte: endDate },
            paymentStatus: {
              in: [PaymentStatus.PAID, PaymentStatus.FULLY_PAID],
            },
            visit: {
              doctorId: filters?.doctorId
                ? Number(filters.doctorId)
                : undefined,
              departmentId: filters?.departmentId
                ? Number(filters.departmentId)
                : undefined,
            },
          },
        }),
        // Completed visits
        db.visit.count({
          where: {
            clinicId: user.clinicId,
            createdAt: { gte: startDate, lte: endDate },
            status: {
              in: [
                VisitStatus.DISCHARGED,
                VisitStatus.DISCHARGED_WITH_PRESCRIPTION,
                VisitStatus.FINALIZED,
              ],
            },
            doctorId: filters?.doctorId ? Number(filters.doctorId) : undefined,
            departmentId: filters?.departmentId
              ? Number(filters.departmentId)
              : undefined,
          },
        }),
        // Active staff count
        db.user.count({
          where: {
            clinicId: user.clinicId,
            status: "ACTIVE",
            role: { in: [Role.DOCTOR, Role.NURSE, Role.LAB_TECHNICIAN] },
          },
        }),
      ]),
      db.$transaction([
        // Previous period visits
        db.visit.count({
          where: {
            clinicId: user.clinicId,
            createdAt: { gte: prevStartDate, lte: prevEndDate },
            doctorId: filters?.doctorId ? Number(filters.doctorId) : undefined,
            departmentId: filters?.departmentId
              ? Number(filters.departmentId)
              : undefined,
          },
        }),
        // Previous period revenue
        db.payment.aggregate({
          _sum: { amount: true },
          where: {
            clinicId: user.clinicId,
            createdAt: { gte: prevStartDate, lte: prevEndDate },
            paymentStatus: {
              in: [PaymentStatus.PAID, PaymentStatus.FULLY_PAID],
            },
            visit: {
              doctorId: filters?.doctorId
                ? Number(filters.doctorId)
                : undefined,
              departmentId: filters?.departmentId
                ? Number(filters.departmentId)
                : undefined,
            },
          },
        }),
        // Previous period completed visits
        db.visit.count({
          where: {
            clinicId: user.clinicId,
            createdAt: { gte: prevStartDate, lte: prevEndDate },
            status: {
              in: [
                VisitStatus.DISCHARGED,
                VisitStatus.DISCHARGED_WITH_PRESCRIPTION,
                VisitStatus.FINALIZED,
              ],
            },
            doctorId: filters?.doctorId ? Number(filters.doctorId) : undefined,
            departmentId: filters?.departmentId
              ? Number(filters.departmentId)
              : undefined,
          },
        }),
        // Previous period active staff (same as current)
        db.user.count({
          where: {
            clinicId: user.clinicId,
            status: "ACTIVE",
            role: { in: [Role.DOCTOR, Role.NURSE, Role.LAB_TECHNICIAN] },
          },
        }),
      ]),
    ]);
    return c.json(
      {
        status: httpCodes.OK,
        message: "Performance overview fetched successfully",
        data: {
          totalVisits: {
            count: currentPeriod[0],
            trend: calculateTrend(currentPeriod[0], previousPeriod[0]),
            trendText: getContextualTrendText(
              currentPeriod[0],
              previousPeriod[0],
              dateRange
            ),
          },
          totalRevenue: {
            count: Number(currentPeriod[1]._sum.amount || 0),
            trend: calculateTrend(
              Number(currentPeriod[1]._sum.amount || 0),
              Number(previousPeriod[1]._sum.amount || 0)
            ),
            trendText: getContextualTrendText(
              Number(currentPeriod[1]._sum.amount || 0),
              Number(previousPeriod[1]._sum.amount || 0),
              dateRange
            ),
          },
          completedVisits: {
            count: currentPeriod[2],
            trend: calculateTrend(currentPeriod[2], previousPeriod[2]),
            trendText: getContextualTrendText(
              currentPeriod[2],
              previousPeriod[2],
              dateRange
            ),
          },
          activeStaff: {
            count: currentPeriod[3],
            trend: 0, // Staff count doesn't change frequently
            trendText: "Active staff members",
          },
        },
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch performance overview",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getDoctorPerformanceMetrics = async (c: Context) => {
  try {
    const user = c.get("user");
    const query = c.get("validatedQuery");
    const { dateRange, filters } = query;
    const { startDate, endDate, prevStartDate, prevEndDate } = getDateRanges(
      dateRange,
      filters
    );
    const whereClause = {
      clinicId: user.clinicId,
      role: Role.DOCTOR,
      status: UserStatus.ACTIVE,
      ...(filters?.doctorId && { id: Number(filters.doctorId) }),
    };
    const doctors = await db.user.findMany({
      where: whereClause,
      select: {
        id: true,
        name: true,
        consultationFee: true,
        clinicalDepartments: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
    const doctorMetrics = await Promise.all(
      doctors.map(async (doctor) => {
        const [currentMetrics, previousMetrics] = await Promise.all([
          getDoctorMetricsForPeriod({
            doctorId: doctor.id,
            startDate,
            endDate,
            clinicId: user.clinicId,
          }),
          getDoctorMetricsForPeriod({
            doctorId: doctor.id,
            startDate: prevStartDate,
            endDate: prevEndDate,
            clinicId: user.clinicId,
          }),
        ]);
        return {
          doctor: {
            id: doctor.id,
            name: doctor.name,
            consultationFee: doctor.consultationFee,
            departments: doctor.clinicalDepartments,
          },
          metrics: {
            totalVisits: {
              count: currentMetrics.totalVisits,
              trend: calculateTrend(
                currentMetrics.totalVisits,
                previousMetrics.totalVisits
              ),
              trendText: calculateTrendText(
                currentMetrics.totalVisits,
                previousMetrics.totalVisits
              ),
            },
            completedVisits: {
              count: currentMetrics.completedVisits,
              trend: calculateTrend(
                currentMetrics.completedVisits,
                previousMetrics.completedVisits
              ),
              trendText: calculateTrendText(
                currentMetrics.completedVisits,
                previousMetrics.completedVisits
              ),
            },
            totalRevenue: {
              count: currentMetrics.totalRevenue,
              trend: calculateTrend(
                currentMetrics.totalRevenue,
                previousMetrics.totalRevenue
              ),
              trendText: calculateTrendText(
                currentMetrics.totalRevenue,
                previousMetrics.totalRevenue
              ),
            },
            avgRevenuePerVisit: {
              count:
                currentMetrics.totalVisits > 0
                  ? Math.round(
                      currentMetrics.totalRevenue / currentMetrics.totalVisits
                    )
                  : 0,
              trend: calculateTrend(
                currentMetrics.totalVisits > 0
                  ? Math.round(
                      currentMetrics.totalRevenue / currentMetrics.totalVisits
                    )
                  : 0,
                previousMetrics.totalVisits > 0
                  ? Math.round(
                      previousMetrics.totalRevenue / previousMetrics.totalVisits
                    )
                  : 0
              ),
              trendText: calculateTrendText(
                currentMetrics.totalVisits > 0
                  ? Math.round(
                      currentMetrics.totalRevenue / currentMetrics.totalVisits
                    )
                  : 0,
                previousMetrics.totalVisits > 0
                  ? Math.round(
                      previousMetrics.totalRevenue / previousMetrics.totalVisits
                    )
                  : 0
              ),
            },
            examOrders: {
              count: currentMetrics.examOrders,
              trend: calculateTrend(
                currentMetrics.examOrders,
                previousMetrics.examOrders
              ),
              trendText: calculateTrendText(
                currentMetrics.examOrders,
                previousMetrics.examOrders
              ),
            },
            treatmentOrders: {
              count: currentMetrics.treatmentOrders,
              trend: calculateTrend(
                currentMetrics.treatmentOrders,
                previousMetrics.treatmentOrders
              ),
              trendText: calculateTrendText(
                currentMetrics.treatmentOrders,
                previousMetrics.treatmentOrders
              ),
            },
          },
        };
      })
    );
    return c.json(
      {
        status: httpCodes.OK,
        message: "Doctor performance metrics fetched successfully",
        data: doctorMetrics,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch doctor performance metrics",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getStaffPerformanceMetrics = async (c: Context) => {
  try {
    const user = c.get("user");
    const query = c.get("validatedQuery");
    const { dateRange, filters } = query;
    const { startDate, endDate, prevStartDate, prevEndDate } = getDateRanges(
      dateRange,
      filters
    );
    const roles = filters?.role
      ? [filters.role]
      : [Role.NURSE, Role.LAB_TECHNICIAN, Role.CASHIER];
    const staff = await db.user.findMany({
      where: {
        clinicId: user.clinicId,
        role: { in: roles },
        status: UserStatus.ACTIVE,
      },
      select: {
        id: true,
        name: true,
        role: true,
        clinicalDepartments: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    const staffMetrics = await Promise.all(
      staff.map(async (member) => {
        const [currentMetrics, previousMetrics] = await Promise.all([
          getStaffMetricsForPeriod({
            staffId: member.id,
            role: member.role,
            startDate,
            endDate,
            clinicId: user.clinicId,
          }),
          getStaffMetricsForPeriod({
            staffId: member.id,
            role: member.role,
            startDate: prevStartDate,
            endDate: prevEndDate,
            clinicId: user.clinicId,
          }),
        ]);

        return {
          staff: {
            id: member.id,
            name: member.name,
            role: member.role,
            departments: member.clinicalDepartments,
          },
          metrics: currentMetrics.map((metric, index) => ({
            name: metric.name,
            count: metric.count,
            type: metric.type as "service" | "revenue",
            trend: calculateTrend(
              metric.count,
              previousMetrics[index]?.count || 0
            ),
            trendText: calculateTrendText(
              metric.count,
              previousMetrics[index]?.count || 0
            ),
          })),
        };
      })
    );
    return c.json(
      {
        status: httpCodes.OK,
        message: "Staff performance metrics fetched successfully",
        data: staffMetrics,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch staff performance metrics",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getTopPerformers = async (c: Context) => {
  try {
    const user = c.get("user");
    const query = c.get("validatedQuery");
    const { dateRange, filters, limit } = query;
    const { startDate, endDate } = getDateRanges(dateRange, filters);

    const topDoctorsByVisits = await db.user.findMany({
      where: {
        clinicId: user.clinicId,
        role: Role.DOCTOR,
        status: "ACTIVE",
        doctorVisits: {
          some: {
            createdAt: { gte: startDate, lte: endDate },
          },
        },
      },
      select: {
        id: true,
        name: true,
        _count: {
          select: {
            doctorVisits: {
              where: {
                createdAt: { gte: startDate, lte: endDate },
              },
            },
          },
        },
      },
      orderBy: {
        doctorVisits: {
          _count: "desc",
        },
      },
      take: limit,
    });

    const topDoctorsByRevenue = await db.user.findMany({
      where: {
        clinicId: user.clinicId,
        role: Role.DOCTOR,
        status: "ACTIVE",
      },
      select: {
        id: true,
        name: true,
        doctorVisits: {
          where: {
            createdAt: { gte: startDate, lte: endDate },
          },
          select: {
            payments: {
              where: {
                paymentStatus: {
                  in: [PaymentStatus.PAID, PaymentStatus.FULLY_PAID],
                },
              },
              select: {
                amount: true,
              },
            },
          },
        },
      },
    });

    const topRevenueData = topDoctorsByRevenue
      .map((doctor) => ({
        id: doctor.id,
        name: doctor.name,
        revenue: doctor.doctorVisits.reduce(
          (total, visit) =>
            total +
            visit.payments.reduce(
              (sum, payment) => sum + Number(payment.amount),
              0
            ),
          0
        ),
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit);

    return c.json(
      {
        status: httpCodes.OK,
        message: "Top performers fetched successfully",
        data: {
          topByVisits: topDoctorsByVisits.map((doctor) => ({
            id: doctor.id,
            name: doctor.name,
            count: doctor._count.doctorVisits,
          })),
          topByRevenue: topRevenueData,
        },
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch top performers",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getPerformanceChartData = async (c: Context) => {
  try {
    const user = c.get("user");
    const query = c.get("validatedQuery");
    const { dateRange, filters } = query;
    const { startDate, endDate } = getDateRanges(dateRange, filters);

    const days: Date[] = [];
    for (
      let d = new Date(startDate);
      d <= endDate;
      d.setDate(d.getDate() + 1)
    ) {
      days.push(new Date(d));
    }

    const chartData = await Promise.all(
      days.map(async (date) => {
        const dayStart = startOfDay(date);
        const dayEnd = endOfDay(date);

        const [visits, revenue, completedVisits] = await db.$transaction([
          db.visit.count({
            where: {
              clinicId: user.clinicId,
              createdAt: { gte: dayStart, lte: dayEnd },
              ...(filters?.doctorId && {
                doctorId: Number(filters.doctorId),
              }),
              ...(filters?.departmentId && {
                departmentId: Number(filters.departmentId),
              }),
            },
          }),
          db.payment.aggregate({
            _sum: { amount: true },
            where: {
              clinicId: user.clinicId,
              createdAt: { gte: dayStart, lte: dayEnd },
              paymentStatus: {
                in: [PaymentStatus.PAID, PaymentStatus.FULLY_PAID],
              },
              ...(filters?.doctorId || filters?.departmentId
                ? {
                    visit: {
                      ...(filters?.doctorId && {
                        doctorId: Number(filters.doctorId),
                      }),
                      ...(filters?.departmentId && {
                        departmentId: Number(filters.departmentId),
                      }),
                    },
                  }
                : {}),
            },
          }),
          db.visit.count({
            where: {
              clinicId: user.clinicId,
              createdAt: { gte: dayStart, lte: dayEnd },
              status: {
                in: [
                  VisitStatus.DISCHARGED,
                  VisitStatus.DISCHARGED_WITH_PRESCRIPTION,
                  VisitStatus.FINALIZED,
                ],
              },
              ...(filters?.doctorId && {
                doctorId: Number(filters.doctorId),
              }),
              ...(filters?.departmentId && {
                departmentId: Number(filters.departmentId),
              }),
            },
          }),
        ]);

        return {
          date: format(date, "MMM dd"),
          visits,
          revenue: Number(revenue._sum.amount || 0),
          completions: completedVisits,
        };
      })
    );

    return c.json(
      {
        status: httpCodes.OK,
        message: "Performance chart data fetched successfully",
        data: chartData,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch performance chart data",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const exportPerformanceData = async (c: Context) => {
  try {
    const user = c.get("user");
    const query = c.get("validatedQuery");
    const { dateRange, filters } = query;
    const { startDate, endDate } = getDateRanges(dateRange, filters);
    const performanceData = await db.visit.findMany({
      where: {
        clinicId: user.clinicId,
        createdAt: { gte: startDate, lte: endDate },
        ...(filters?.doctorId && { doctorId: Number(filters.doctorId) }),
        ...(filters?.departmentId && {
          departmentId: Number(filters.departmentId),
        }),
      },
      select: {
        id: true,
        createdAt: true,
        status: true,
        patient: { select: { firstName: true, lastName: true } },
        doctor: { select: { name: true } },
        department: { select: { name: true } },
        payments: {
          select: { amount: true, paymentStatus: true },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });
    const exportData = performanceData.map((visit) => ({
      id: visit.id,
      date: format(visit.createdAt, "yyyy-MM-dd"),
      patientName: `${visit.patient.firstName} ${visit.patient.lastName}`,
      doctorName: visit.doctor?.name,
      department: visit.department?.name,
      status: visit.status,
      totalAmount: visit.payments.reduce(
        (sum, payment) => sum + Number(payment.amount),
        0
      ),
      isPaid: visit.payments.some(
        (payment) =>
          payment.paymentStatus === PaymentStatus.PAID ||
          payment.paymentStatus === PaymentStatus.FULLY_PAID
      ),
    }));
    return c.json(
      {
        status: httpCodes.OK,
        message: "Performance data exported successfully",
        data: exportData,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to export performance data",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

/**
 * Get detailed visits for a specific doctor and date range
 */

export const getDetailedVisits = async (c: Context) => {
  try {
    const user = c.get("user");
    const query = c.get("validatedQuery");
    const { dateRange, filters, metricType, page, pageSize } = query;
    const { startDate, endDate } = getDateRanges(dateRange, filters);

    const whereClause: Prisma.VisitWhereInput & {
      status?: { in: VisitStatus[] };
    } = {
      clinicId: user.clinicId,
      doctorId: filters?.doctorId ? Number(filters.doctorId) : undefined,
      createdAt: { gte: startDate, lte: endDate },
      departmentId: filters?.departmentId
        ? Number(filters.departmentId)
        : undefined,
    };
    if (metricType === "completed") {
      whereClause.status = {
        in: [
          VisitStatus.DISCHARGED,
          VisitStatus.DISCHARGED_WITH_PRESCRIPTION,
          VisitStatus.FINALIZED,
        ],
      };
    }
    const totalCount = await db.visit.count({ where: whereClause });
    const visits = await db.visit.findMany({
      where: whereClause,
      select: {
        id: true,
        createdAt: true,
        status: true,
        patient: {
          select: { firstName: true, lastName: true, phoneNumber: true },
        },
        doctor: { select: { name: true } },
        department: { select: { name: true } },
        payments: {
          where: {
            paymentStatus: {
              in: [PaymentStatus.PAID, PaymentStatus.FULLY_PAID],
            },
          },
          select: { amount: true },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const detailedData = visits.map((visit) => ({
      id: visit.id,
      patientName: `${visit.patient.firstName} ${visit.patient.lastName}`,
      patientPhone: visit.patient.phoneNumber,
      date: visit.createdAt.toISOString(),
      status: visit.status,
      department: visit.department?.name,
      doctor: visit.doctor?.name,
      amount: visit.payments.reduce(
        (sum, payment) => sum + Number(payment.amount),
        0
      ),
    }));
    return c.json(
      {
        status: httpCodes.OK,
        message: "Detailed visits fetched successfully",
        data: detailedData,
        total: totalCount,
        page,
        pageSize,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch detailed visits",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getDetailedExams = async (c: Context) => {
  try {
    const user = c.get("user");
    const query = c.get("validatedQuery");
    const { dateRange, filters, page, pageSize } = query;
    const { startDate, endDate } = getDateRanges(dateRange, filters);
    const whereClause = {
      clinicId: user.clinicId,
      doctorId: filters?.doctorId ? Number(filters.doctorId) : undefined,
      createdAt: { gte: startDate, lte: endDate },
      departmentId: filters?.departmentId
        ? Number(filters.departmentId)
        : undefined,
    };

    const totalCount = await db.exam.count({ where: whereClause });
    const exams = await db.exam.findMany({
      where: whereClause,
      select: {
        id: true,
        createdAt: true,
        status: true,
        name: true,
        visit: {
          select: {
            id: true,
            patient: {
              select: { firstName: true, lastName: true, phoneNumber: true },
            },
            doctor: { select: { name: true } },
            department: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const detailedData = exams.map((exam) => ({
      id: exam.id,
      patientName: `${exam.visit?.patient.firstName} ${exam.visit?.patient.lastName}`,
      patientPhone: exam.visit?.patient.phoneNumber,
      date: exam.createdAt.toISOString(),
      status: exam.status,
      department: exam.visit?.department?.name,
      doctor: exam.visit?.doctor?.name,
      examType: exam.name,
      amount: 0,
    }));
    return c.json(
      {
        status: httpCodes.OK,
        message: "Detailed exams fetched successfully",
        data: detailedData,
        total: totalCount,
        page,
        pageSize,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch detailed exams",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getDetailedTreatments = async (c: Context) => {
  try {
    const user = c.get("user");
    const query = c.get("validatedQuery");
    const { dateRange, filters, page, pageSize } = query;
    const { startDate, endDate } = getDateRanges(dateRange, filters);
    const whereClause = {
      clinicId: user.clinicId,
      doctorId: filters?.doctorId ? Number(filters.doctorId) : undefined,
      createdAt: { gte: startDate, lte: endDate },
      departmentId: filters?.departmentId
        ? Number(filters.departmentId)
        : undefined,
    };
    const totalCount = await db.treatment.count({ where: whereClause });
    const treatments = await db.treatment.findMany({
      where: whereClause,
      select: {
        id: true,
        createdAt: true,
        name: true,
        visit: {
          select: {
            id: true,
            patient: {
              select: { firstName: true, lastName: true, phoneNumber: true },
            },
            doctor: { select: { name: true } },
            department: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const detailedData = treatments.map((treatment) => ({
      id: treatment.id,
      patientName: `${treatment.visit?.patient.firstName} ${treatment.visit?.patient.lastName}`,
      patientPhone: treatment.visit?.patient.phoneNumber,
      date: treatment.createdAt.toISOString(),
      status: "COMPLETED",
      department: treatment.visit?.department?.name,
      doctor: treatment.visit?.doctor?.name,
      treatmentType: treatment.name,
      amount: 0,
    }));
    return c.json(
      {
        status: httpCodes.OK,
        message: "Detailed treatments fetched successfully",
        data: detailedData,
        total: totalCount,
        page,
        pageSize,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch detailed treatments",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getStaffDetailedActivities = async (c: Context) => {
  try {
    const user = c.get("user");
    const query = c.get("validatedQuery");
    const { dateRange, filters, page, pageSize } = query;
    const { startDate, endDate } = getDateRanges(dateRange, filters);

    let response: {
      success: boolean;
      data: unknown;
      total: number;
      page: number;
      pageSize: number;
      totalPages: number;
    } = {
      success: true,
      data: [],
      total: 0,
      page: 1,
      pageSize: 10,
      totalPages: 0,
    } as const;

    switch (filters?.role) {
      case Role.NURSE: {
        // Fetch visits checked in by this nurse
        const whereClauseNurse = {
          checkedInById: filters?.staffId ? Number(filters.staffId) : undefined,
          clinicId: user.clinicId,
          createdAt: { gte: startDate, lte: endDate },
          departmentId: filters?.departmentId
            ? Number(filters.departmentId)
            : undefined,
        };

        const totalNurseCount = await db.visit.count({
          where: whereClauseNurse,
        });

        const nurseVisits = await db.visit.findMany({
          where: whereClauseNurse,
          select: {
            id: true,
            createdAt: true,
            status: true,
            patient: {
              select: {
                firstName: true,
                lastName: true,
                phoneNumber: true,
              },
            },
            doctor: {
              select: {
                name: true,
              },
            },
            department: {
              select: {
                name: true,
              },
            },
            checkedInBy: {
              select: {
                name: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        });

        const nurseData = nurseVisits.map((visit) => ({
          id: visit.id,
          patientName: `${visit.patient.firstName} ${visit.patient.lastName}`,
          patientPhone: visit.patient.phoneNumber,
          date: visit.createdAt.toISOString(),
          status: visit.status,
          department: visit.department?.name || "Unknown",
          doctor: visit.doctor?.name || "Assigned",
          amount: 0, // Nurses don't directly handle payments
          staffMember: visit.checkedInBy?.name || "Unknown",
        }));

        response = {
          success: true,
          data: nurseData,
          total: totalNurseCount,
          page,
          pageSize,
          totalPages: Math.ceil(totalNurseCount / pageSize),
        };
        break;
      }
      case Role.CASHIER:
      case Role.PHARMACIST: {
        // Fetch payments processed by this staff member
        const whereClausePayment = {
          processedById: filters?.staffId ? Number(filters.staffId) : undefined,
          clinicId: user.clinicId,
          createdAt: { gte: startDate, lte: endDate },
          paymentStatus: {
            in: [PaymentStatus.PAID, PaymentStatus.FULLY_PAID],
          },
        };

        const totalPaymentCount = await db.payment.count({
          where: whereClausePayment,
        });

        const staffPayments = await db.payment.findMany({
          where: whereClausePayment,
          select: {
            id: true,
            amount: true,
            paymentType: true,
            paymentStatus: true,
            paymentMode: true,
            createdAt: true,
            processedBy: {
              select: { name: true },
            },
            visit: {
              select: {
                id: true,
                patient: {
                  select: {
                    firstName: true,
                    lastName: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        });

        const paymentData = staffPayments.map((payment) => ({
          id: payment.id,
          patientName: `${payment.visit?.patient.firstName} ${payment.visit?.patient.lastName}`,
          visitId: payment.visit?.id || 0,
          date: payment.createdAt.toISOString(),
          amount: Number(payment.amount),
          type: payment.paymentType,
          status: payment.paymentStatus,
          method: payment.paymentMode,
          staffMember: payment.processedBy?.name || "Unknown",
        }));

        response = {
          success: true,
          data: paymentData,
          total: totalPaymentCount,
          page,
          pageSize,
          totalPages: Math.ceil(totalPaymentCount / pageSize),
        };
        break;
      }

      case Role.LAB_TECHNICIAN: {
        // Fetch exam results completed by this lab technician
        const whereClauseExam = {
          createdById: filters?.staffId ? Number(filters.staffId) : undefined,
          createdAt: { gte: startDate, lte: endDate },
          exam: {
            visit: { clinicId: user.clinicId },
          },
        };

        const totalExamCount = await db.examResult.count({
          where: whereClauseExam,
        });

        const examResults = await db.examResult.findMany({
          where: whereClauseExam,
          select: {
            id: true,
            examDate: true,
            results: true,
            notes: true,
            createdAt: true,
            createdBy: {
              select: { name: true },
            },
            exam: {
              select: {
                name: true,
                visit: {
                  select: {
                    id: true,
                    patient: {
                      select: {
                        firstName: true,
                        lastName: true,
                        phoneNumber: true,
                      },
                    },
                    department: {
                      select: {
                        name: true,
                      },
                    },
                    doctor: {
                      select: {
                        name: true,
                      },
                    },
                  },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        });

        const examData = examResults.map((result) => ({
          id: result.id,
          patientName: `${result.exam?.visit?.patient.firstName} ${result.exam?.visit?.patient.lastName}`,
          patientPhone: result.exam?.visit?.patient.phoneNumber,
          date: result.createdAt.toISOString(),
          status: "COMPLETED",
          department: result.exam?.visit?.department?.name || "Unknown",
          doctor: result.exam?.visit?.doctor?.name || "Unknown",
          examType: result.exam?.name || "Unknown",
          amount: 0, // Lab results don't have direct amounts
          staffMember: result.createdBy?.name || "Unknown",
        }));

        response = {
          success: true,
          data: examData,
          total: totalExamCount,
          page,
          pageSize,
          totalPages: Math.ceil(totalExamCount / pageSize),
        };
        break;
      }
      default: {
        // For other roles, return empty data
        response = {
          success: true,
          data: [],
          total: 0,
          page: 1,
          pageSize: 10,
          totalPages: 0,
        };
        break;
      }
    }

    return c.json(
      {
        status: httpCodes.OK,
        message: "Staff detailed activities fetched successfully",
        data: response,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch staff detailed activities",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

/**
 * Get detailed payments for a specific doctor and date range
 */
export const getDetailedPayments = async (c: Context) => {
  try {
    const user = c.get("user");
    const query = c.get("validatedQuery");
    const { dateRange, filters, page, pageSize } = query;
    const { startDate, endDate } = getDateRanges(dateRange, filters);
    const whereClause = {
      clinicId: user.clinicId,
      doctorId: filters?.doctorId ? Number(filters.doctorId) : undefined,
      createdAt: { gte: startDate, lte: endDate },
      paymentStatus: {
        in: [PaymentStatus.PAID, PaymentStatus.FULLY_PAID],
      },
      visit: {
        ...(filters?.doctorId && { doctorId: Number(filters.doctorId) }),
        departmentId: filters?.departmentId
          ? Number(filters.departmentId)
          : undefined,
      },
    };
    const totalCount = await db.payment.count({ where: whereClause });
    const payments = await db.payment.findMany({
      where: whereClause,
      select: {
        id: true,
        amount: true,
        paymentType: true,
        paymentStatus: true,
        paymentMode: true,
        createdAt: true,
        visit: {
          select: {
            id: true,
            patient: { select: { firstName: true, lastName: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const detailedData = payments.map((payment) => ({
      id: payment.id,
      patientName: `${payment.visit?.patient.firstName} ${payment.visit?.patient.lastName}`,
      visitId: payment.visit?.id || 0,
      date: payment.createdAt.toISOString(),
      amount: Number(payment.amount),
      type: payment.paymentType,
      status: payment.paymentStatus,
      method: payment.paymentMode,
    }));
    return c.json(
      {
        status: httpCodes.OK,
        message: "Detailed payments fetched successfully",
        data: detailedData,
        total: totalCount,
        page,
        pageSize,
        totalPages: Math.ceil(totalCount / pageSize),
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch detailed payments",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getPerformanceFilterData = async (c: Context) => {
  try {
    const user = c.get("user");
    const [doctors, departments, roles] = await Promise.all([
      getClinicDoctorsForFilter(user.clinicId),
      getClinicDepartmentsForFilter(user.clinicId),
      getClinicStaffRolesForFilter(user.clinicId),
    ]);
    return c.json(
      {
        status: httpCodes.OK,
        message: "Performance filter data fetched successfully",
        data: {
          doctors: doctors.data,
          departments: departments.data,
          roles: roles.data,
        },
        errors: {
          doctors: doctors.error,
          departments: departments.error,
          roles: roles.error,
        },
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
