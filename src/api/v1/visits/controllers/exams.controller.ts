import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createPaymentForInventoryItems } from "@/helpers/inventory-helpers";
import { httpCodes } from "@/lib/constants";
import type { Prisma } from "../../../../../generated/prisma/client";
import {
  ActivityType,
  PaymentType,
  SmsEventType,
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
import { QueueIntegrationService } from "../../../../services/queue-integration.service";
import { SmsService } from "../../../../services/sms.service";

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
        PaymentType.ADDITIONAL_EXAM,
        {}
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
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
          },
        },
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

    if (visit.patient.phoneNumber) {
      SmsService.queueEventMessage({
        clinicId: visit.clinicId,
        visitId: visit.id,
        patientId: visit.patient.id,
        phoneNumber: visit.patient.phoneNumber,
        eventType: SmsEventType.LAB_RESULTS_READY,
        message: `Hi ${visit.patient.firstName}, your lab results are ready. Please return for doctor review.`,
        metadata: {
          visitId: visit.id,
          doctorId: visit.doctorId,
        },
      }).catch(() => {
        /* SMS is best-effort; do not fail results ready flow */
      });
    }

    // Auto-join doctor queue so patient re-joins for results review
    if (visit.doctorId != null && visit.branchId != null) {
      QueueIntegrationService.ensurePatientInDoctorQueue({
        doctorId: visit.doctorId,
        patientId: visit.patient.id,
        clinicId: visit.clinicId,
        branchId: visit.branchId,
        visitId: visit.id,
      }).catch(() => {
        /* Queue integration is best-effort; do not fail results ready flow */
      });
    }

    return c.json({ success: "Visit marked as results ready", data: updated });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

type ExamEditRefundApprovalPayment = {
  id: number;
  paymentStatus: string;
  paidAmount: unknown;
  patientAmount: unknown;
  insuranceAmount: unknown;
  amount: unknown;
  paymentDetails: unknown;
  insuranceClaimId: number | null;
  refunds?: Array<{
    id: number;
    productId: number;
    examResultId: number | null;
    patientRefundAmount: unknown;
    insuranceAdjustmentAmount: unknown;
    totalAdjustmentAmount: unknown;
    approvalId: number | null;
    approval?: { status: string } | null;
  }>;
};

type ExamEditRefundItem = {
  paymentId: number;
  productId: number;
  productName: string;
  quantity: number;
  amount: number;
  patientAmount: number;
  insuranceAmount: number;
  patientRefundAmount: number;
  insuranceAdjustmentAmount: number;
  totalAdjustmentAmount: number;
};

type AdditionalExamPaymentDetailLine = {
  productId?: number;
  productName?: string;
  amount: number;
  patientAmount: number;
  insuranceAmount: number;
  quantity?: number;
};

const getApprovedRefundsForProduct = (
  payment: ExamEditRefundApprovalPayment,
  productId: number
) => {
  const refunds = payment.refunds ?? [];
  return refunds.filter((r) => {
    if (r.productId !== productId) {
      return false;
    }
    if (r.approvalId == null) {
      return true;
    }
    return r.approval?.status === "APPROVED";
  });
};

const sumRefundAmounts = (
  refunds: ReturnType<typeof getApprovedRefundsForProduct>
) => {
  let patientRefundAmount = 0;
  let insuranceAdjustmentAmount = 0;
  let totalAdjustmentAmount = 0;

  for (const refund of refunds) {
    patientRefundAmount += Number(refund.patientRefundAmount ?? 0);
    insuranceAdjustmentAmount += Number(refund.insuranceAdjustmentAmount ?? 0);
    totalAdjustmentAmount += Number(refund.totalAdjustmentAmount ?? 0);
  }

  return {
    patientRefundAmount,
    insuranceAdjustmentAmount,
    totalAdjustmentAmount,
  };
};

const buildExamEditRefundItem = (args: {
  payment: ExamEditRefundApprovalPayment;
  line: AdditionalExamPaymentDetailLine;
  examProducts: Array<{ id: number; name: string }>;
  paidRatio: number;
}): ExamEditRefundItem | null => {
  const { payment, line, examProducts, paidRatio } = args;
  if (line.productId == null) {
    return null;
  }

  const linePatientAmount = Number(line.patientAmount ?? 0);
  const computedPatientRefundAmount = Number(
    (linePatientAmount * paidRatio).toFixed(2)
  );
  const computedInsuranceAdjustmentAmount = Number(line.insuranceAmount ?? 0);
  const computedTotalAdjustmentAmount =
    computedPatientRefundAmount + computedInsuranceAdjustmentAmount;

  const approvedRefunds = getApprovedRefundsForProduct(payment, line.productId);
  const already = sumRefundAmounts(approvedRefunds);

  const patientRefundAmount = Number(
    Math.max(
      0,
      computedPatientRefundAmount - already.patientRefundAmount
    ).toFixed(2)
  );
  const insuranceAdjustmentAmount = Number(
    Math.max(
      0,
      computedInsuranceAdjustmentAmount - already.insuranceAdjustmentAmount
    ).toFixed(2)
  );
  const totalAdjustmentAmount = Number(
    Math.max(
      0,
      computedTotalAdjustmentAmount - already.totalAdjustmentAmount
    ).toFixed(2)
  );

  if (patientRefundAmount <= 0 && insuranceAdjustmentAmount <= 0) {
    return null;
  }

  return {
    paymentId: payment.id,
    productId: line.productId,
    productName:
      line.productName ??
      examProducts.find((p) => p.id === line.productId)?.name ??
      `Product #${line.productId}`,
    quantity: line.quantity ?? 1,
    amount: Number(line.amount ?? 0),
    patientAmount: linePatientAmount,
    insuranceAmount: Number(line.insuranceAmount ?? 0),
    patientRefundAmount,
    insuranceAdjustmentAmount,
    totalAdjustmentAmount,
  };
};

const createConsolidatedRefundApproval = async (args: {
  payments: ExamEditRefundApprovalPayment[];
  examEditApprovalId: number;
  examToEdit: {
    id: number;
    products: Array<{ id: number; name: string }>;
  };
  productIds: number[];
  originalProductIds: number[];
  visit: {
    id: number;
    clinicId: number;
    patient: { firstName: string; lastName: string };
  };
  user: { id: number | string; branchId?: number | null };
  //biome-ignore lint/complexity/noExcessiveCognitiveComplexity:<>
}) => {
  const { payments, examToEdit, productIds, originalProductIds, visit, user } =
    args;
  const removedProductIds = originalProductIds.filter(
    (pid) => !productIds.includes(pid)
  );

  if (removedProductIds.length === 0) {
    return false;
  }

  const refundItems: ExamEditRefundItem[] = [];

  for (const payment of payments) {
    if (payment.paymentStatus === "PENDING") {
      continue;
    }

    const paymentDetails = (payment.paymentDetails ??
      []) as AdditionalExamPaymentDetailLine[];

    const removedLines = paymentDetails.filter(
      (line) =>
        line.productId != null && removedProductIds.includes(line.productId)
    );

    const paidAmount = Number(payment.paidAmount ?? 0);
    const totalPaymentPatientAmount = Number(payment.patientAmount ?? 0);
    const paidRatio =
      totalPaymentPatientAmount > 0
        ? Math.min(paidAmount / totalPaymentPatientAmount, 1)
        : 0;

    for (const line of removedLines) {
      const refundItem = buildExamEditRefundItem({
        payment,
        line,
        examProducts: examToEdit.products,
        paidRatio,
      });
      if (refundItem) {
        refundItems.push(refundItem);
      }
    }
  }

  if (refundItems.length === 0) {
    return false;
  }

  const totalPatientRefund = refundItems.reduce(
    (sum, item) => sum + item.patientRefundAmount,
    0
  );
  const totalInsuranceAdjustment = refundItems.reduce(
    (sum, item) => sum + item.insuranceAdjustmentAmount,
    0
  );
  const patientName = `${visit.patient.firstName} ${visit.patient.lastName}`;

  await db.approval.create({
    data: {
      type: "REFUND",
      clinicId: visit.clinicId,
      branchId: user.branchId ?? undefined,
      requestedById: Number(user.id),
      reason: `Refund for removed exams — part of exam edit for ${patientName}`,
      payload: {
        examEditApprovalId: args.examEditApprovalId,
        paymentIds: payments.map((p) => p.id),
        visitId: visit.id,
        examId: examToEdit.id,
        examEditRefund: true,
        patient: { fullName: patientName },
        items: refundItems,
        requested: {
          refund: {
            patientRefundAmount: Number(totalPatientRefund.toFixed(2)),
            insuranceAdjustmentAmount: Number(
              totalInsuranceAdjustment.toFixed(2)
            ),
            totalAdjustmentAmount: Number(
              (totalPatientRefund + totalInsuranceAdjustment).toFixed(2)
            ),
          },
        },
        original: {
          payments: payments.map((p) => ({
            paymentId: p.id,
            amount: Number(p.amount),
            patientAmount: Number(p.patientAmount),
            insuranceAmount: Number(p.insuranceAmount ?? 0),
            paidAmount: Number(p.paidAmount),
            insuranceClaimId: p.insuranceClaimId,
          })),
        },
      },
    },
  });

  return true;
};

export const requestVisitExamEdit = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.req.param();
    const visitId = Number.parseInt(id, 10);
    const data = c.get("validatedJson");
    const { exams, reason } = data;

    const visit = await db.visit.findUnique({
      where: { id: visitId },
      select: {
        id: true,
        clinicId: true,
        patient: { select: { firstName: true, lastName: true } },
        exams: {
          orderBy: { createdAt: "desc" as const },
          take: 1,
          select: {
            id: true,
            products: { select: { id: true, name: true } },
            results: { select: { id: true } },
          },
        },
      },
    });

    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const examToEdit = visit.exams[0];
    if (!examToEdit) {
      return c.json(
        { error: "No exam request found to edit" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    if (examToEdit.results.length > 0) {
      return c.json(
        {
          error:
            "Exam results already exist for this request. Exam edits can no longer be applied.",
        },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const payments = await db.payment.findMany({
      where: {
        visitId,
        paymentType: PaymentType.ADDITIONAL_EXAM,
      },
      orderBy: { createdAt: "desc" as const },
      select: {
        id: true,
        allowPartial: true,
        paymentStatus: true,
        paymentMode: true,
        paymentType: true,
        amount: true,
        patientAmount: true,
        insuranceAmount: true,
        paidAmount: true,
        insuranceClaimId: true,
        paymentDetails: true,
        refunds: {
          select: {
            id: true,
            productId: true,
            examResultId: true,
            patientRefundAmount: true,
            insuranceAdjustmentAmount: true,
            totalAdjustmentAmount: true,
            reason: true,
            approvalId: true,
            approval: { select: { status: true } },
          },
        },
      },
    });

    const latestPayment = payments[0];
    if (!latestPayment) {
      return c.json(
        { error: "No exam bill found for this visit." },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const isPaidBill = latestPayment.paymentStatus !== "PENDING";

    const productIds = (exams as string[]).map((e) => Number.parseInt(e, 10));
    const originalProductIds = examToEdit.products.map((p) => p.id);

    const existingPendingApproval = await db.approval.findFirst({
      where: {
        type: "EXAM_EDIT",
        examId: examToEdit.id,
        status: "PENDING",
      },
    });

    if (existingPendingApproval) {
      return c.json(
        { error: "A pending edit request already exists for this exam" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const approval = await db.approval.create({
      data: {
        type: "EXAM_EDIT",
        clinicId: visit.clinicId,
        branchId: user.branchId ?? undefined,
        requestedById: Number(user.id),
        reason,
        examId: examToEdit.id,
        payload: {
          paymentId: latestPayment.id,
          paidBill: isPaidBill,
          original: {
            exams: originalProductIds,
            allowPartial: Boolean(latestPayment.allowPartial),
          },
          requested: {
            exams: productIds,
            allowPartial: Boolean(latestPayment.allowPartial),
          },
        },
      },
    });

    const refundApprovalCreated = await createConsolidatedRefundApproval({
      payments,
      examEditApprovalId: approval.id,
      examToEdit,
      productIds,
      originalProductIds,
      visit,
      user,
    });

    await logActivity({
      userId: Number(user.id),
      visitId,
      type: ActivityType.TASK,
      action: `Dr. ${user.name} requested approval to update additional lab exams for ${visit.patient.firstName} ${visit.patient.lastName}`,
    });

    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });

    return c.json({
      success: true,
      message: refundApprovalCreated
        ? "Submitted for approval. A refund request has also been created for removed exams."
        : "Submitted for approval",
      data: approval,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal Server Error";
    return c.json(
      { error: message },
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
      PaymentType.ADDITIONAL_EXAM,
      {}
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

    await invalidatePaymentRelatedCaches({
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
        PaymentType.TREATMENT,
        {}
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
