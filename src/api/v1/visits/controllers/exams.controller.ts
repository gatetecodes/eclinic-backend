import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createPaymentForInventoryItems } from "@/helpers/inventory-helpers";
import { httpCodes } from "@/lib/constants";
import type { Prisma } from "../../../../../generated/prisma/client";
import {
  ActivityType,
  PaymentType,
  VisitStatus,
} from "../../../../../generated/prisma/client";
import { db } from "../../../../database/db";
import { logActivity } from "../../../../helpers/activity-helpers";
import { createPaymentForProducts } from "../../../../helpers/tariff-helpers";
import {
  getCachier,
  getLabTechnicians,
} from "../../../../helpers/visit-helper";
import {
  invalidatePaymentRelatedCaches,
  invalidateVisitRelatedCaches,
} from "../../../../lib/cache-utils";

export const addExams = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.get("validatedParam");
    const visitId = Number.parseInt(id, 10);
    const data = c.get("validatedJson");

    const visit = await db.visit.findUnique({
      where: { id: visitId },
      select: {
        id: true,
        patient: { select: { firstName: true, lastName: true } },
      },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const productIds = data.exams.map((e: string) => Number.parseInt(e, 10));
    let payment: { id: number; paymentType: string } | null;
    try {
      payment = await createPaymentForProducts(
        productIds,
        visitId,
        PaymentType.ADDITIONAL_EXAM
      );
    } catch (error) {
      const message = (error as Error).message;
      return c.json(
        { error: message },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    if (!payment) {
      return c.json(
        { error: "Error generating exams payment" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const exam = await db.exam.create({
      data: {
        clinic: { connect: { id: user.clinicId } },
        visit: { connect: { id: visitId } },
        products: { connect: productIds.map((pid: number) => ({ id: pid })) },
      },
    });

    await db.visit.update({
      where: { id: visitId },
      data: {
        payments: { connect: { id: payment.id } },
        exams: { connect: { id: exam.id } },
      },
    });

    await logActivity({
      userId: Number(user.id),
      visitId,
      type: ActivityType.TASK,
      action: `Dr. ${user.name} requested additional lab exams for ${visit.patient.firstName} ${visit.patient.lastName}`,
    });

    const labTechs = await getLabTechnicians(user.branchId);
    const cachier = await getCachier(user.branchId);
    if (labTechs.length > 0) {
      await db.notification.create({
        data: {
          userId: labTechs[0].id,
          title: "New lab exam requested",
          message: `Dr. ${user.name} requested additional lab exams for ${visit.patient.firstName} ${visit.patient.lastName}`,
          type: "LAB_EXAM_REQUEST",
          visitId,
        },
      });
    }
    if (cachier) {
      await db.notification.create({
        data: {
          userId: cachier.id,
          title: "New payment bill",
          message: `New ${payment.paymentType} payment bill for ${visit.patient.firstName} ${visit.patient.lastName} has been created`,
          type: "NEW_PAYMENT_BILL",
          visitId,
        },
      });
    }

    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });
    await invalidatePaymentRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });

    return c.json({
      success: "Exam added successfully",
      data: { id: exam.id },
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getVisitExam = async (c: Context) => {
  try {
    const { id } = c.req.param();
    const visitId = Number.parseInt(id, 10);
    const exam = await db.exam.findFirst({
      where: { visitId },
      select: {
        name: true,
        products: { select: { id: true, name: true } },
        results: {
          select: {
            id: true,
            examDate: true,
            results: true,
            notes: true,
            createdBy: { select: { id: true, name: true } },
          },
        },
      },
    });
    return c.json({ data: exam });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const markResultsReady = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.get("validatedParam");
    const visitId = Number.parseInt(id, 10);

    const visit = await db.visit.findUnique({
      where: { id: visitId },
      select: {
        id: true,
        clinicId: true,
        branchId: true,
        doctorId: true,
        patient: { select: { id: true, firstName: true, lastName: true } },
        doctor: { select: { id: true, name: true } },
      },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const updated = await db.$transaction(async (tx) => {
      await tx.exam.updateMany({
        where: { visitId },
        data: { status: "COMPLETED" },
      });
      const updatedVisit = await tx.visit.update({
        where: { id: visitId },
        data: { status: VisitStatus.RESULTS_READY },
      });
      return updatedVisit;
    });

    await logActivity({
      userId: Number(user.id),
      visitId,
      type: ActivityType.STATUS_UPDATE,
      action: `${visit.patient.firstName} ${visit.patient.lastName}'s results for requested exams marked READY`,
    });

    if (visit.doctorId != null) {
      await db.notification.create({
        data: {
          userId: visit.doctorId,
          title: "Lab Results Ready",
          message: `${visit.patient.firstName} ${visit.patient.lastName}'s results for requested exams marked READY`,
          type: "LAB_EXAM_RESULTS",
          visitId,
        },
      });
    }

    const cashier = await getCachier(Number(visit.branchId));
    if (cashier) {
      await db.notification.create({
        data: {
          userId: cashier.id,
          title: "Lab Results Ready",
          message: `${visit.patient.firstName} ${visit.patient.lastName}'s results for requested exams marked READY`,
          type: "LAB_EXAM_RESULTS",
          visitId,
        },
      });
    }

    await invalidateVisitRelatedCaches({
      clinicId: visit.clinicId,
      branchId: Number(visit.branchId ?? 0),
      visitId,
    });

    return c.json({ success: "Visit marked as results ready", data: updated });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const editVisitExams = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.req.param();
    const visitId = Number.parseInt(id, 10);
    const { exams } = await c.req.json();

    const visit = await db.visit.findUnique({
      where: { id: visitId },
      select: {
        id: true,
        patient: { select: { firstName: true, lastName: true } },
      },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const productIds = (exams as string[]).map((e) => Number.parseInt(e, 10));
    const payment = await db.payment.findFirst({
      where: { visitId, paymentType: "ADDITIONAL_EXAM" },
      select: { id: true },
    });
    if (!payment) {
      return c.json(
        { error: "Payment not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    await db.payment.delete({ where: { id: payment.id } });
    const newPayment = await createPaymentForProducts(
      productIds,
      visitId,
      PaymentType.ADDITIONAL_EXAM
    );
    if (!newPayment) {
      return c.json(
        { error: "Error creating payment" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const updatedVisit = await db.$transaction(async (tx) => {
      await tx.exam.deleteMany({ where: { visitId } });
      const newExam = await tx.exam.create({
        data: {
          clinic: { connect: { id: user.clinicId } },
          visit: { connect: { id: visitId } },
          products: { connect: productIds.map((pid) => ({ id: pid })) },
        },
      });
      return tx.visit.update({
        where: { id: visitId },
        data: {
          payments: { connect: { id: newPayment.id } },
          exams: { connect: { id: newExam.id } },
        },
      });
    });

    await logActivity({
      userId: Number(user.id),
      visitId,
      type: ActivityType.TASK,
      action: `Dr. ${user.name} updated additional lab exams for ${visit.patient.firstName} ${visit.patient.lastName}`,
    });

    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });

    return c.json({
      success: "Visit exams updated successfully",
      data: updatedVisit,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const addTreatment = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.req.param();
    const visitId = Number.parseInt(id, 10);
    const { treatments } = await c.req.json();

    const visit = await db.visit.findUnique({
      where: { id: visitId },
      select: {
        id: true,
        patient: { select: { firstName: true, lastName: true } },
      },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    const productIds = (treatments as string[]).map((t) =>
      Number.parseInt(t, 10)
    );
    let payment: { id: number; paymentType: string } | null;
    try {
      payment = await createPaymentForProducts(
        productIds,
        visitId,
        PaymentType.TREATMENT
      );
    } catch (error) {
      return c.json(
        { error: (error as Error).message },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    if (!payment) {
      return c.json(
        { error: "Error generating treatment payment" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const treatment = await db.treatment.create({
      data: {
        visit: { connect: { id: visitId } },
        products: {
          connect: productIds.map((productId) => ({ id: productId })),
        },
      },
    });
    const updatedVisitRecord = await db.visit.update({
      where: { id: visitId },
      data: {
        payments: { connect: { id: payment.id } },
        treatments: { connect: { id: treatment.id } },
      },
    });

    await logActivity({
      userId: Number(user.id),
      visitId: updatedVisitRecord.id,
      type: ActivityType.TASK,
      action: `Dr. ${user.name} added ${treatment.name} to ${visit.patient.firstName} ${visit.patient.lastName}`,
    });

    const cachier = await getCachier(user.branchId);
    if (cachier) {
      await db.notification.create({
        data: {
          userId: cachier.id,
          title: "New payment bill",
          message: `New ${payment.paymentType} payment bill for ${visit.patient.firstName} ${visit.patient.lastName} has been created`,
          type: "NEW_PAYMENT_BILL",
          visitId,
        },
      });
    }

    return c.json(
      {
        success: true,
        message: "Treatment act(s) added successfully",
        data: updatedVisitRecord,
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
export const addNurseTreatment = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.get("validatedParam");
    const visitId = Number.parseInt(id, 10);
    const { treatments, allowPartial } = c.get("validatedJson");

    const visit = await db.visit.findUnique({
      where: { id: visitId },
      select: {
        id: true,
        patient: { select: { firstName: true, lastName: true } },
      },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const result = await db.$transaction(async (tx) => {
      const updatedVisit = await tx.visit.update({
        where: { id: visitId },
        data: {
          medicConsumables: treatments as unknown as Prisma.InputJsonValue,
        },
      });
      const payment = await createPaymentForInventoryItems(
        treatments.map((treatment: { id: string; quantity: string }) => ({
          id: treatment.id,
          quantity: Number(treatment.quantity),
        })),
        visitId,
        PaymentType.MEDICATION,
        { allowPartial, userId: Number(user.id) }
      );
      return { updatedVisit, payment };
    });

    return c.json({
      success: "Medic/Consumables added successfully",
      data: { updatedVisit: result.updatedVisit, payment: result.payment },
    });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
