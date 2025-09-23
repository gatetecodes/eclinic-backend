import { endOfToday, startOfToday } from "date-fns";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  type Prisma,
  type Visit,
  VisitStatus,
} from "../../../../../generated/prisma";
import { db } from "../../../../database/db";
import { buildQueryOptions } from "../../../../helpers/query-helper";
import { searchParamsSchema } from "../../../../lib/common-validation";
import { httpCodes } from "../../../../lib/constants";

export const getVisitsWithPrescriptions = async (c: Context) => {
  try {
    const params = searchParamsSchema.parse(c.req.query());

    const queryOptions = buildQueryOptions<Visit>(params);
    const { where, orderBy, ...restOptions } = queryOptions;

    const visits = await db.visit.findMany({
      ...restOptions,
      where: {
        ...where,
        status: VisitStatus.DISCHARGED_WITH_PRESCRIPTION,
        prescriptions: { some: { status: "ISSUED" } },
      } as Prisma.VisitWhereInput,
      orderBy: orderBy as Prisma.VisitOrderByWithRelationInput,
      include: { patient: true, prescriptions: true },
    });

    return c.json({ data: visits });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getTodaysVisits = async (c: Context) => {
  try {
    const user = c.get("user");
    const start = startOfToday();
    const end = endOfToday();
    const visits = await db.visit.findMany({
      where: {
        OR: [
          { status: VisitStatus.ADMITTED },
          { createdAt: { gte: start, lte: end } },
        ],
        clinicId: user.clinic.id,
      },
      select: {
        id: true,
        patient: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    return c.json(visits);
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const exportVisits = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const queryOptions = buildQueryOptions<Visit>(params);
    const { where, orderBy, ...restOptions } = queryOptions;
    const visits = await db.visit.findMany({
      ...restOptions,
      where: { ...(where as Prisma.VisitWhereInput), clinicId: user.clinic.id },
      orderBy: orderBy as Prisma.VisitOrderByWithRelationInput,
      select: {
        id: true,
        createdAt: true,
        paymentMode: true,
        patientInsurance: {
          select: { insuranceCompany: { select: { companyName: true } } },
        },
        patient: {
          select: { firstName: true, lastName: true, phoneNumber: true },
        },
        department: { select: { name: true } },
        doctor: { select: { name: true } },
        payments: {
          select: { amount: true, patientAmount: true, insuranceAmount: true },
        },
      },
    });

    const visitsWithTotals = visits.map((v) => ({
      ...v,
      patientAmount: Number(
        v.payments.reduce((sum, p) => sum + Number(p.patientAmount), 0)
      ),
      insuranceAmount: Number(
        v.payments.reduce((sum, p) => sum + Number(p.insuranceAmount ?? 0), 0)
      ),
      totalAmount: Number(
        v.payments.reduce((sum, p) => sum + Number(p.amount), 0)
      ),
    }));

    return c.json(visitsWithTotals);
  } catch (_error) {
    return c.json(
      { error: "Failed to export visits" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
