import { parse } from "date-fns";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { httpCodes } from "@/lib/constants";
import { parseDateString } from "@/lib/utils";
import type {
  Gender,
  PaymentMode,
  Prisma,
  Visit,
} from "../../../../../generated/prisma/client";

type IInsurancePrice = {
  id: number;
  price: Prisma.Decimal;
  priceWithCo?: Prisma.Decimal | null;
  clinicId?: number | null;
  insuranceCompany: {
    id: number;
    companyName: string;
  };
};

type IProductWithPrices = {
  id: number;
  name: string;
  basePrice?: Prisma.Decimal | null;
  eastAfricaPrice?: Prisma.Decimal | null;
  africaPrice?: Prisma.Decimal | null;
  restOfWorldPrice?: Prisma.Decimal | null;
  clinicProductPrices?: Array<{
    basePrice?: Prisma.Decimal | null;
    eastAfricaPrice?: Prisma.Decimal | null;
    africaPrice?: Prisma.Decimal | null;
    restOfWorldPrice?: Prisma.Decimal | null;
  }>;
  insurancePrices: IInsurancePrice[];
};

import {
  ActivityType,
  PaymentType,
  QueuePurpose,
  Role,
  VisitStatus,
} from "../../../../../generated/prisma/client";
import { db } from "../../../../database/db";
import { logActivity } from "../../../../helpers/activity-helpers";
import { buildQueryOptions } from "../../../../helpers/query-helper";
import { createPaymentForProducts } from "../../../../helpers/tariff-helpers";
import {
  dischargeVisit as dischargeVisitHelper,
  getCachier,
  getOrCreatePatient,
} from "../../../../helpers/visit-helper";
import {
  invalidateDashboardRelatedCaches,
  invalidatePaymentRelatedCaches,
  invalidateVisitRelatedCaches,
} from "../../../../lib/cache-utils";
import { searchParamsSchema } from "../../../../lib/common-validation";
import { getScope } from "../../../../lib/request-scope";
import { QueueIntegrationService } from "../../../../services/queue-integration.service";
import {
  DEFAULT_CACHE_TTL,
  getCachedData,
} from "../../../../services/redis.service";
import {
  consultationNoteSchema,
  editChiefComplaintSchema,
  type finalizeVisitSchema,
  type IUpdateInitialCheckIn,
  initialCheckInSchema,
  preConsultationSchema,
  updateVisitStatusSchema,
} from "../visits.validation";

// Helper to handle consultation bill creation with minimal impact on main flow
async function maybeCreateConsultationBill({
  visit,
  allowPartial,
  branchId,
}: {
  visit: {
    id: number;
    requiresConsultation: boolean;
    consultations?: Array<{ id: number }>;
    patient: { firstName: string; lastName: string };
  };
  allowPartial?: boolean;
  branchId?: number | null;
}) {
  if (!visit.requiresConsultation) {
    return;
  }
  const consultationIds = visit.consultations?.map((item) => item.id) ?? [];
  if (consultationIds.length === 0) {
    return;
  }
  await createPaymentForProducts(
    consultationIds,
    visit.id,
    PaymentType.CONSULTATION,
    { allowPartial: Boolean(allowPartial) }
  );
  if (typeof branchId === "number") {
    const paymentCashier = await getCachier(branchId);
    if (paymentCashier) {
      await db.notification.create({
        data: {
          userId: paymentCashier.id,
          title: "New payment bill",
          message: `New CONSULTATION payment bill for ${visit.patient.firstName} ${visit.patient.lastName} has been created`,
          type: "NEW_PAYMENT_BILL",
          visitId: visit.id,
        },
      });
    }
  }
}

//biome-ignore lint/complexity/noExcessiveCognitiveComplexity:<>
export const createInitialCheckIn = async (c: Context) => {
  try {
    const user = c.get("user");
    const parsed = initialCheckInSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const {
      patient,
      departmentId,
      priority,
      isLabOnly,
      doctorId,
      consultationProductIds,
      labProductIds,
      requiresConsultation,
      paymentMode,
      allowPartial,
      insurance,
      selectedPatientId,
    } = parsed.data as z.infer<typeof initialCheckInSchema>;

    const { patientId, isNewPatient } = await getOrCreatePatient(
      patient,
      user,
      selectedPatientId ? Number.parseInt(selectedPatientId, 10) : undefined
    );

    // Resolve patient insurance if provided
    let patientInsuranceId: number | undefined;
    if (
      paymentMode === "INSURANCE" &&
      insurance &&
      Object.keys(insurance).length > 0
    ) {
      const { handleInsurance } = await import(
        "../../../../helpers/visit-helper"
      );
      patientInsuranceId = await handleInsurance(
        insurance as unknown as NonNullable<IUpdateInitialCheckIn["insurance"]>,
        patientId
      );
    }

    const visit = await db.visit.create({
      data: {
        patient: { connect: { id: patientId } },
        department: departmentId
          ? { connect: { id: Number.parseInt(departmentId, 10) } }
          : undefined,
        status: VisitStatus.CHECKED_IN,
        priority,
        doctor: doctorId
          ? { connect: { id: Number.parseInt(doctorId, 10) } }
          : undefined,
        consultations: consultationProductIds
          ? {
              connect: consultationProductIds.map((pid) => ({
                id: Number.parseInt(pid, 10),
              })),
            }
          : undefined,
        isNewPatient,
        clinic: { connect: { id: user.clinicId } },
        branch: { connect: { id: user.branchId } },
        checkedInBy: { connect: { id: Number(user.id) } },
        isLabOnly,
        requiresConsultation: requiresConsultation ?? !isLabOnly,
        paymentMode: paymentMode as PaymentMode | undefined,
        patientInsurance: patientInsuranceId
          ? { connect: { id: patientInsuranceId } }
          : undefined,
      },
      include: {
        patient: true,
        department: true,
        consultations: { select: { id: true } },
      },
    });

    // Create consultation bill immediately when applicable
    try {
      await maybeCreateConsultationBill({
        visit,
        allowPartial,
        branchId: user.branchId,
      });
      // Lab-only visits should create lab payment bills immediately
      const labProductIdsNumbers = (labProductIds ?? [])
        .map((pid) => Number.parseInt(pid, 10))
        .filter((pid) => Number.isFinite(pid));
      if (isLabOnly && labProductIdsNumbers.length > 0) {
        // Create exam record first to ensure data consistency
        // If exam creation fails, no payment will be created
        await db.exam.create({
          data: {
            clinic: { connect: { id: user.clinicId } },
            visit: { connect: { id: visit.id } },
            products: {
              connect: labProductIdsNumbers.map((pid) => ({ id: pid })),
            },
          },
        });

        // Create payment after exam is successfully created
        const labPayment = await createPaymentForProducts(
          labProductIdsNumbers,
          visit.id,
          PaymentType.ADDITIONAL_EXAM,
          { allowPartial: Boolean(allowPartial) }
        );

        const paymentCashier = await getCachier(user.branchId);
        if (paymentCashier) {
          await db.notification.create({
            data: {
              userId: paymentCashier.id,
              title: "New payment bill",
              message: `New ${String(labPayment.paymentType)} payment bill for ${visit.patient.firstName} ${visit.patient.lastName} has been created`,
              type: "NEW_PAYMENT_BILL",
              visitId: visit.id,
            },
          });
        }
      }
    } catch (error) {
      const message = (error as Error).message;
      return c.json(
        { error: message },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId: visit.id,
    });
    await invalidatePaymentRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId: visit.id,
    });
    await invalidateDashboardRelatedCaches(user.clinicId);

    // Auto-join queue if doctor is assigned
    if (doctorId && !isLabOnly) {
      const docId = Number.parseInt(doctorId, 10);
      if (Number.isFinite(docId)) {
        await QueueIntegrationService.ensurePatientInDoctorQueue({
          doctorId: docId,
          patientId: visit.patientId,
          clinicId: user.clinicId,
          branchId: user.branchId,
          visitId: visit.id,
        });
      }
    }

    return c.json(
      { success: "Patient checked in successfully", visit },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Failed to check in patient." },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

/**
 * Helper function to resolve patient insurance ID
 */
async function resolvePatientInsurance(
  paymentMode: string | undefined,
  insurance: unknown,
  patientId: number
): Promise<number | undefined> {
  if (paymentMode !== "INSURANCE") {
    return;
  }
  if (!insurance || typeof insurance !== "object") {
    return;
  }
  if (Object.keys(insurance).length === 0) {
    return;
  }
  const { handleInsurance } = await import("../../../../helpers/visit-helper");
  return await handleInsurance(
    insurance as unknown as NonNullable<IUpdateInitialCheckIn["insurance"]>,
    patientId
  );
}

/**
 * Helper function to determine patient insurance connection/disconnection
 */
function getPatientInsuranceRelation(
  patientInsuranceId: number | undefined,
  paymentMode: string | undefined
): { connect: { id: number } } | { disconnect: true } | undefined {
  if (patientInsuranceId) {
    return { connect: { id: patientInsuranceId } };
  }
  if (paymentMode !== "INSURANCE") {
    return { disconnect: true };
  }
}

/**
 * Helper function to delete pending payment of a specific type
 */
async function deletePendingPayment(
  visitId: number,
  paymentType: PaymentType
): Promise<void> {
  const existingPayment = await db.payment.findFirst({
    where: {
      visitId,
      paymentType,
      paymentStatus: "PENDING",
    },
  });
  if (existingPayment) {
    await db.payment.delete({ where: { id: existingPayment.id } });
  }
}

/**
 * Helper function to handle consultation payment bill update
 */
async function handleConsultationPaymentUpdate(params: {
  requiresConsultation: boolean;
  consultationProductIds: string[] | undefined;
  visitId: number;
  allowPartial: boolean | undefined;
  branchId: number | null;
  patientName: string;
}): Promise<void> {
  const {
    requiresConsultation,
    consultationProductIds,
    visitId,
    allowPartial,
    branchId,
    patientName,
  } = params;

  if (!requiresConsultation) {
    await deletePendingPayment(visitId, PaymentType.CONSULTATION);
    return;
  }

  if (!consultationProductIds || consultationProductIds.length === 0) {
    await deletePendingPayment(visitId, PaymentType.CONSULTATION);
    return;
  }

  const consultationIds = consultationProductIds
    .map((pid) => Number.parseInt(pid, 10))
    .filter((pid) => Number.isFinite(pid));

  if (consultationIds.length === 0) {
    await deletePendingPayment(visitId, PaymentType.CONSULTATION);
    return;
  }

  try {
    await deletePendingPayment(visitId, PaymentType.CONSULTATION);

    // Create new payment bill with updated consultation products
    const consultationPayment = await createPaymentForProducts(
      consultationIds,
      visitId,
      PaymentType.CONSULTATION,
      { allowPartial: Boolean(allowPartial) }
    );

    if (branchId && consultationPayment) {
      const paymentCashier = await getCachier(branchId);
      if (paymentCashier) {
        await db.notification.create({
          data: {
            userId: paymentCashier.id,
            title: "Payment bill updated",
            message: `Consultation payment bill for ${patientName} has been updated`,
            type: "NEW_PAYMENT_BILL",
            visitId,
          },
        });
      }
    }
  } catch {
    // Silently fail consultation payment update to not break the main update flow
  }
}

/**
 * Helper function to handle lab products payment update
 */
async function handleLabProductsUpdate(params: {
  isLabOnly: boolean;
  labProductIds: string[] | undefined;
  visitId: number;
  allowPartial: boolean | undefined;
  branchId: number | null;
  clinicId: number;
  patientName: string;
}): Promise<void> {
  const {
    isLabOnly,
    labProductIds,
    visitId,
    allowPartial,
    branchId,
    clinicId,
    patientName,
  } = params;

  if (!isLabOnly) {
    await deletePendingPayment(visitId, PaymentType.ADDITIONAL_EXAM);
    // Also delete any exams if it's no longer lab-only
    await db.exam.deleteMany({ where: { visitId } });
    return;
  }

  if (!labProductIds || labProductIds.length === 0) {
    await deletePendingPayment(visitId, PaymentType.ADDITIONAL_EXAM);
    // Delete exams if no products
    await db.exam.deleteMany({ where: { visitId } });
    return;
  }

  const labProductIdsNumbers = labProductIds
    .map((pid) => Number.parseInt(pid, 10))
    .filter((pid) => Number.isFinite(pid));

  if (labProductIdsNumbers.length === 0) {
    await deletePendingPayment(visitId, PaymentType.ADDITIONAL_EXAM);
    await db.exam.deleteMany({ where: { visitId } });
    return;
  }

  try {
    await deletePendingPayment(visitId, PaymentType.ADDITIONAL_EXAM);

    // Update exams: delete existing and create new
    await db.exam.deleteMany({ where: { visitId } });
    await db.exam.create({
      data: {
        clinic: { connect: { id: clinicId } },
        visit: { connect: { id: visitId } },
        products: {
          connect: labProductIdsNumbers.map((pid) => ({ id: pid })),
        },
      },
    });

    // Create new payment bill with updated lab products
    const labPayment = await createPaymentForProducts(
      labProductIdsNumbers,
      visitId,
      PaymentType.ADDITIONAL_EXAM,
      { allowPartial: Boolean(allowPartial) }
    );

    if (branchId && labPayment) {
      const paymentCashier = await getCachier(branchId);
      if (paymentCashier) {
        await db.notification.create({
          data: {
            userId: paymentCashier.id,
            title: "Payment bill updated",
            message: `Lab payment bill for ${patientName} has been updated`,
            type: "NEW_PAYMENT_BILL",
            visitId,
          },
        });
      }
    }
  } catch {
    // Silently fail lab products update to not break the main update flow
  }
}

/**
 * UPDATE INITIAL CHECK-IN
 * @param c
 * @returns
 */

export const updateInitialCheckIn = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.get("validatedParam");
    const visitId = Number.parseInt(id, 10);
    const data = c.get("validatedJson");
    const {
      patient,
      departmentId,
      priority,
      isLabOnly,
      doctorId,
      consultationProductIds,
      labProductIds,
      requiresConsultation,
      paymentMode,
      allowPartial,
      insurance,
      chiefComplaint,
    } = data as IUpdateInitialCheckIn;

    // Check if visit exists and belongs to the user's clinic
    const existingVisit = await db.visit.findFirst({
      where: {
        id: visitId,
        clinicId: user.clinicId,
      },
      include: {
        patient: true,
      },
    });

    if (!existingVisit) {
      return c.json(
        { error: "Visit not found or access denied" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (existingVisit.status !== VisitStatus.CHECKED_IN) {
      return c.json(
        { error: "Only checked-in visits can be edited" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    // Update patient information
    const updatedPatient = await db.patient.update({
      where: { id: existingVisit.patientId },
      data: {
        firstName: patient.firstName,
        lastName: patient.lastName,
        dateOfBirth: parseDateString(patient.dateOfBirth),
        gender: patient.gender as Gender,
        isChild: patient.isChild,
        phoneNumber: patient.phoneNumber,
        guardianPhoneNumber: patient.guardianPhoneNumber,
        isAForeigner: patient.isAForeigner,
        ...(patient.foreignerRegion != null
          ? { foreignerRegion: patient.foreignerRegion }
          : {}),
      },
    });

    // Resolve patient insurance if provided
    const patientInsuranceId = await resolvePatientInsurance(
      paymentMode,
      insurance,
      updatedPatient.id
    );

    // Update visit
    const updatedVisit = await db.visit.update({
      where: { id: visitId },
      data: {
        department: departmentId
          ? { connect: { id: +departmentId } }
          : { disconnect: true },
        doctor: doctorId
          ? { connect: { id: Number.parseInt(doctorId, 10) } }
          : undefined,
        consultations: consultationProductIds
          ? {
              set: [],
              connect: consultationProductIds.map((pid) => ({
                id: Number.parseInt(pid, 10),
              })),
            }
          : undefined,
        priority,
        isLabOnly: !!isLabOnly,
        requiresConsultation: requiresConsultation ?? !isLabOnly,
        paymentMode: paymentMode as PaymentMode | undefined,
        patientInsurance: getPatientInsuranceRelation(
          patientInsuranceId,
          paymentMode
        ),
        chiefComplaint: chiefComplaint ?? undefined,
      },
      include: {
        patient: true,
        department: true,
        consultations: { select: { id: true } },
      },
    });

    // Handle consultation payment bill update
    await handleConsultationPaymentUpdate({
      requiresConsultation: updatedVisit.requiresConsultation,
      consultationProductIds,
      visitId,
      allowPartial,
      branchId: user.branchId,
      patientName: `${updatedPatient.firstName} ${updatedPatient.lastName}`,
    });

    // Handle lab products update for lab-only visits
    await handleLabProductsUpdate({
      isLabOnly: updatedVisit.isLabOnly,
      labProductIds,
      visitId,
      allowPartial,
      branchId: user.branchId,
      clinicId: user.clinicId,
      patientName: `${updatedPatient.firstName} ${updatedPatient.lastName}`,
    });

    // Log activity
    await logActivity({
      userId: Number(user.id),
      visitId,
      action: `Initial check-in updated for ${updatedPatient.firstName} ${updatedPatient.lastName} by ${user?.name}`,
      type: ActivityType.STATUS_UPDATE,
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
    await invalidateDashboardRelatedCaches(user.clinicId);

    // Auto-join queue if doctor is assigned or changed
    if (doctorId && !isLabOnly) {
      const docId = Number.parseInt(doctorId, 10);
      if (Number.isFinite(docId)) {
        await QueueIntegrationService.ensurePatientInDoctorQueue({
          doctorId: docId,
          patientId: updatedVisit.patientId,
          clinicId: user.clinicId,
          branchId: user.branchId,
          visitId: updatedVisit.id,
        });
      }
    }

    return c.json(
      { success: "Initial check-in updated successfully", visit: updatedVisit },
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

export const addPreConsultation = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.req.param();
    const visitId = Number.parseInt(id, 10);
    const parsed = preConsultationSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const { vitals, notes, chiefComplaint } = parsed.data as z.infer<
      typeof preConsultationSchema
    >;

    const result = await db.$transaction(async (tx) => {
      const visitRecord = await tx.visit.update({
        data: {
          notes,
          status: VisitStatus.IN_CONSULTATION,
          ...(chiefComplaint ? { chiefComplaint } : {}),
        },
        where: { id: visitId },
        select: {
          id: true,
          patientId: true,
          doctorId: true,
          clinicId: true,
          branchId: true,
        },
      });

      const updatedPatient = await tx.patient.update({
        data: {
          medicalInfo: {
            ...(vitals as unknown as Prisma.InputJsonObject),
          },
        },
        where: { id: visitRecord.patientId },
        select: { firstName: true, lastName: true },
      });

      return { updatedVisit: visitRecord, updatedPatient };
    });

    await logActivity({
      userId: Number(user.id),
      visitId,
      type: ActivityType.STATUS_UPDATE,
      action: `Pre-consultation completed by ${user.name}`,
    });

    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });

    // Mark pre-consultation queue entry as SERVED (best-effort)
    QueueIntegrationService.markQueueEntryServedForVisit(
      visitId,
      QueuePurpose.PRE_CONSULTATION
    ).catch(() => {
      /* Queue integration is best-effort; do not fail pre-consultation flow */
    });

    // Auto-join doctor queue when pre-consultation completes (doctor may have been assigned at check-in or during pre-consultation)
    const { updatedVisit } = result;
    if (
      updatedVisit.doctorId &&
      updatedVisit.clinicId &&
      updatedVisit.branchId
    ) {
      QueueIntegrationService.ensurePatientInDoctorQueue({
        doctorId: updatedVisit.doctorId,
        patientId: updatedVisit.patientId,
        clinicId: updatedVisit.clinicId,
        branchId: updatedVisit.branchId,
        visitId: updatedVisit.id,
      }).catch(() => {
        /* Queue integration is best-effort; do not fail pre-consultation flow */
      });
    }

    return c.json({
      success: "Pre-consultation details updated",
      data: result,
    });
  } catch (_error) {
    return c.json(
      { error: "Failed to update pre-consultation details" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

/**
 * EDIT PRE-CONSULTATION
 * @param c
 * @returns
 */

export const editPreConsultation = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.get("validatedParam");
    const visitId = Number.parseInt(id, 10);
    const data = c.get("validatedJson");
    const { vitals, notes, chiefComplaint } = data as z.infer<
      typeof preConsultationSchema
    >;

    // Check if visit exists and belongs to the user's clinic
    const existingVisit = await db.visit.findFirst({
      where: {
        id: visitId,
        clinicId: user.clinicId,
        branchId: user.branchId,
      },
      include: {
        patient: true,
      },
    });

    if (!existingVisit) {
      return c.json(
        { error: "Visit not found or access denied" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (existingVisit.status === VisitStatus.CHECKED_IN) {
      // Check if visit is in appropriate status for editing pre-consultation
      return c.json(
        {
          error:
            "Please complete initial triage before editing pre-consultation details",
        },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    if (existingVisit.isLabOnly) {
      return c.json(
        {
          error:
            "Pre-consultation details are not applicable for lab-only visits.",
        },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const updatePatientAndVisit = await db.$transaction(async (tx) => {
      // Update visit with new pre-consultation data
      const updatedVisit = await tx.visit.update({
        data: {
          notes,
          ...(typeof chiefComplaint === "string" && chiefComplaint
            ? { chiefComplaint }
            : {}),
        },
        where: {
          id: visitId,
        },
      });

      // Update patient's medical info with new vitals
      const updatedPatient = await tx.patient.update({
        data: {
          medicalInfo: {
            ...vitals,
          },
        },
        where: {
          id: existingVisit.patientId,
        },
      });

      return { updatedPatient, updatedVisit };
    });

    // Log activity
    await logActivity({
      userId: Number(user.id),
      visitId,
      action: `Pre-consultation details updated for ${updatePatientAndVisit.updatedPatient.firstName} ${updatePatientAndVisit.updatedPatient.lastName} by ${user?.name}`,
      type: ActivityType.STATUS_UPDATE,
    });

    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });

    return c.json(
      {
        success: "Pre-consultation details updated successfully",
        data: updatePatientAndVisit,
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

export const addPaymentMethod = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.get("validatedParam");
    const visitId = Number.parseInt(id, 10);
    const data = c.get("validatedJson");
    const { paymentMode, insurance, allowPartial } = data as {
      paymentMode: string;
      insurance?: Record<string, unknown>;
      allowPartial?: boolean;
    };

    const visit = await db.visit.findUnique({
      where: { id: visitId },
      select: {
        id: true,
        requiresConsultation: true,
        patientId: true,
        doctorId: true,
        departmentId: true,
        patient: { select: { firstName: true, lastName: true } },
        consultations: { select: { id: true } },
      },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (!(visit.doctorId || visit.departmentId)) {
      return c.json(
        { error: "Visit missing doctor or department" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    let patientInsuranceId: number | undefined;
    if (insurance && Object.keys(insurance).length > 0) {
      const { handleInsurance } = await import(
        "../../../../helpers/visit-helper"
      );
      patientInsuranceId = await handleInsurance(
        insurance as unknown as NonNullable<IUpdateInitialCheckIn["insurance"]>,
        visit.patientId
      );
    }

    const updatedVisit = await db.visit.update({
      where: { id: visitId },
      data: {
        paymentMode: paymentMode as PaymentMode,
        patientInsuranceId,
      },
      include: { consultations: true },
    });

    if (visit.requiresConsultation) {
      const consultationProductIds = updatedVisit.consultations.map(
        (cons: { id: number }) => cons.id
      );
      try {
        const consultationPayment = await createPaymentForProducts(
          consultationProductIds,
          updatedVisit.id,
          PaymentType.CONSULTATION,
          { allowPartial }
        );
        const paymentCashier = await getCachier(user.branchId);
        if (paymentCashier) {
          await db.notification.create({
            data: {
              userId: paymentCashier.id,
              title: "New payment bill",
              message: `New ${String(consultationPayment.paymentType)} payment bill for ${visit.patient.firstName} ${visit.patient.lastName} has been created`,
              type: "NEW_PAYMENT_BILL",
              visitId,
            },
          });
        }
      } catch (error) {
        const message = (error as Error).message;
        return c.json(
          { error: message },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
      }
    }

    await logActivity({
      userId: Number(user.id),
      visitId,
      type: ActivityType.PAYMENT,
      action: `${user.name} updated visit with payment mode`,
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
      success: "Payment method added successfully",
      data: updatedVisit,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const listVisits = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId, branchId } = getScope(user, params);
    const cacheKey = `visits:${clinicId ?? "ALL"}:${branchId ?? "ALL"}:${user.role}:${JSON.stringify(
      params
    )}`;

    const data = await getCachedData(
      cacheKey,
      async () => {
        const queryOptions = buildQueryOptions<Visit>(params, {
          ...(typeof clinicId === "number" ? { clinicId } : {}),
          ...(typeof branchId === "number" ? { branchId } : {}),
        });
        const { where, orderBy, ...restOptions } = queryOptions;

        // Role-based status visibility
        let roleStatusFilter: Prisma.VisitWhereInput["status"] | undefined;
        if (user.role === Role.LAB_TECHNICIAN) {
          roleStatusFilter = VisitStatus.PENDING_TESTS;
        } else if (user.role === Role.DOCTOR) {
          roleStatusFilter = {
            in: [
              VisitStatus.CHECKED_IN,
              VisitStatus.TRIAGE_COMPLETED,
              VisitStatus.IN_CONSULTATION,
              VisitStatus.PENDING_TESTS,
              VisitStatus.RESULTS_READY,
              VisitStatus.FINALIZED,
              VisitStatus.DISCHARGED,
              VisitStatus.DISCHARGED_WITH_PRESCRIPTION,
              VisitStatus.ADMITTED,
            ],
          } as Prisma.VisitWhereInput["status"]; // explicit to satisfy types
        } else if (user.role === Role.NURSE) {
          roleStatusFilter = {
            in: [
              VisitStatus.IN_PRE_CONSULTATION,
              VisitStatus.TRIAGE_COMPLETED,
              VisitStatus.IN_CONSULTATION,
              VisitStatus.PENDING_TESTS,
              VisitStatus.RESULTS_READY,
              VisitStatus.DISCHARGED,
              VisitStatus.DISCHARGED_WITH_PRESCRIPTION,
              VisitStatus.FINALIZED,
            ],
          } as Prisma.VisitWhereInput["status"]; // explicit to satisfy types
        }

        const statusFilter: Prisma.VisitWhereInput["status"] | undefined =
          roleStatusFilter
            ? roleStatusFilter
            : (where?.status as Prisma.VisitWhereInput["status"] | undefined);

        const whereInput: Prisma.VisitWhereInput = {
          ...where,
          status: statusFilter,
        };

        const visits = await db.visit.findMany({
          ...restOptions,
          where: whereInput,
          orderBy: orderBy as Prisma.VisitOrderByWithRelationInput,
          include: {
            clinic: { select: { id: true, name: true } },
            patient: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                phoneNumber: true,
                dateOfBirth: true,
                gender: true,
                address: true,
                email: true,
                isChild: true,
                guardianPhoneNumber: true,
                isAForeigner: true,
                foreignerRegion: true,
              },
            },
            department: { select: { id: true, name: true } },
            doctor: { select: { id: true, name: true } },
            patientInsurance: {
              select: {
                id: true,
                insuranceNumber: true,
                insuranceCompany: { select: { companyName: true } },
              },
            },
            consultation: { select: { id: true, name: true } },
            consultations: { select: { id: true, name: true } },
            prescriptions: {
              select: {
                id: true,
                items: {
                  select: {
                    id: true,
                    medicationName: true,
                    dosage: true,
                    frequency: true,
                    duration: true,
                    instructions: true,
                  },
                },
              },
            },
            spectaclePrescription: {
              select: {
                id: true,
                rightEye: true,
                leftEye: true,
                interpupillaryDistance: true,
                lensType: true,
              },
            },
          },
        });

        const totalCount = await db.visit.count({ where: whereInput });
        const pageCount = restOptions.take
          ? Math.ceil(totalCount / restOptions.take)
          : 0;
        return { data: visits, totalCount, pageCount };
      },
      DEFAULT_CACHE_TTL.SHORT
    );

    return c.json(data);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal Server Error",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getVisitById = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.req.param();
    const visitId = Number.parseInt(id, 10);
    const cacheKey = `visit:${visitId}`;

    const data = await getCachedData(
      cacheKey,
      async () => {
        const visit = await db.visit.findUnique({
          where: { id: visitId },
          select: {
            id: true,
            status: true,
            paymentMode: true,
            consultationNote: true,
            transferReason: true,
            chiefComplaint: true,
            basicTriage: true,
            diagnosis: true,
            examConclusions: true,
            treatmentComments: true,
            followUpDate: true,
            updatedAt: true,
            clinicId: true,
            branchId: true,
            clinic: { select: { id: true, name: true } },
            branch: { select: { id: true, name: true } },
            patient: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                isChild: true,
                dateOfBirth: true,
                gender: true,
                phoneNumber: true,
                nationality: true,
                isAForeigner: true,
                foreignerRegion: true,
                address: true,
                medicalInfo: true,
                email: true,
                guardianPhoneNumber: true,
              },
            },
            doctor: { select: { id: true, name: true } },
            department: { select: { id: true, name: true } },
            patientInsurance: {
              select: {
                id: true,
                coveragePercentage: true,
                insuranceNumber: true,
                relationshipType: true,
                principalName: true,
                principalPhoneNumber: true,
                employer: { select: { id: true, employerName: true } },
                insuranceCompany: { select: { companyName: true } },
              },
            },
            consultations: { select: { id: true, name: true } },
            payments: {
              select: {
                id: true,
                amount: true,
                insuranceAmount: true,
                patientAmount: true,
                paymentType: true,
                paymentStatus: true,
              },
            },
            prescriptions: {
              select: {
                id: true,
                items: {
                  select: {
                    id: true,
                    medicationName: true,
                    dosage: true,
                    frequency: true,
                    duration: true,
                    instructions: true,
                  },
                },
              },
            },
            spectaclePrescription: {
              select: {
                id: true,
                rightEye: true,
                leftEye: true,
                interpupillaryDistance: true,
                lensType: true,
              },
            },
            exams: {
              select: {
                id: true,
                name: true,
                createdAt: true,
                products: {
                  select: {
                    id: true,
                    name: true,
                    unit: true,
                    normalRange: true,
                    basePrice: true,
                    eastAfricaPrice: true,
                    africaPrice: true,
                    restOfWorldPrice: true,
                    clinicProductPrices: {
                      where: {
                        clinicId: user.clinicId,
                      },
                      select: {
                        basePrice: true,
                        eastAfricaPrice: true,
                        africaPrice: true,
                        restOfWorldPrice: true,
                      },
                      take: 1,
                    },
                    insurancePrices: {
                      where: {
                        OR: [{ clinicId: user.clinicId }, { clinicId: null }],
                      },
                      select: {
                        id: true,
                        price: true,
                        priceWithCo: true,
                        clinicId: true,
                        insuranceCompany: {
                          select: {
                            id: true,
                            companyName: true,
                          },
                        },
                      },
                    },
                    tests: {
                      select: {
                        id: true,
                        name: true,
                        unit: true,
                        normalRange: true,
                        consumables: true,
                      },
                    },
                  },
                },
                results: {
                  select: {
                    id: true,
                    examDate: true,
                    results: true,
                    notes: true,
                    createdAt: true,
                    createdBy: { select: { id: true, name: true } },
                  },
                },
              },
            },
            treatments: true,
            examResults: {
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

        if (!visit) {
          return null;
        }

        // Transform products in exams to include clinic-specific prices
        const transformedExams = (visit.exams || []).map((exam) => ({
          ...exam,
          products: (exam.products || []).map((p) => {
            const product = p as unknown as IProductWithPrices;
            const clinicPrice = product.clinicProductPrices?.[0];
            const insurancePrices = product.insurancePrices || [];

            return {
              ...product,
              basePrice: clinicPrice?.basePrice ?? product.basePrice,
              eastAfricaPrice:
                clinicPrice?.eastAfricaPrice ?? product.eastAfricaPrice,
              africaPrice: clinicPrice?.africaPrice ?? product.africaPrice,
              restOfWorldPrice:
                clinicPrice?.restOfWorldPrice ?? product.restOfWorldPrice,
              insurancePrices: (() => {
                const clinicSpecific = insurancePrices.filter(
                  (ip) => ip.clinicId === user.clinicId
                );
                const global = insurancePrices.filter(
                  (ip) => ip.clinicId === null
                );
                const clinicCompanyIds = new Set(
                  clinicSpecific.map((ip) => ip.insuranceCompany.id)
                );
                const globalOnly = global.filter(
                  (ip) => !clinicCompanyIds.has(ip.insuranceCompany.id)
                );
                return [...clinicSpecific, ...globalOnly];
              })(),
              clinicProductPrices: undefined,
            };
          }),
        }));

        return { data: { ...visit, exams: transformedExams } };
      },
      DEFAULT_CACHE_TTL.SHORT
    );

    if (!data?.data) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const visit = data.data as {
      clinicId: number;
      branchId: number;
      exams: unknown[];
    } & Record<string, unknown>;

    const notSuper = user.role !== Role.SUPER_ADMIN;
    if (notSuper && visit.clinicId !== user.clinicId) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    if (notSuper && visit.branchId !== user.branchId) {
      return c.json(
        { error: "Forbidden" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    return c.json(data);
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const getPatientVisits = async (c: Context) => {
  try {
    const user = c.get("user");
    const { patientId } = c.get("validatedParam");
    const pid = Number.parseInt(patientId, 10);
    const visits = await db.visit.findMany({
      where: { patientId: pid },
      include: {
        patient: true,
        department: true,
        doctor: true,
        exams: {
          include: {
            products: {
              include: {
                tests: true,
                clinicProductPrices: {
                  where: { clinicId: user.clinicId },
                  take: 1,
                },
                insurancePrices: {
                  where: {
                    OR: [{ clinicId: user.clinicId }, { clinicId: null }],
                  },
                  include: { insuranceCompany: true },
                },
              },
            },
            results: true,
          },
        },
        examResults: { include: { createdBy: true } },
        prescriptions: { include: { items: true } },
        patientInsurance: {
          include: { employer: true, insuranceCompany: true },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    // Transform products in exams for all visits
    const transformedVisits = visits.map((visit) => ({
      ...visit,
      exams: (visit.exams || []).map((exam) => ({
        ...exam,
        products: (exam.products || []).map((p) => {
          const product = p as unknown as IProductWithPrices;
          const clinicPrice = product.clinicProductPrices?.[0];
          const insurancePrices = product.insurancePrices || [];

          return {
            ...product,
            basePrice: clinicPrice?.basePrice ?? product.basePrice,
            eastAfricaPrice:
              clinicPrice?.eastAfricaPrice ?? product.eastAfricaPrice,
            africaPrice: clinicPrice?.africaPrice ?? product.africaPrice,
            restOfWorldPrice:
              clinicPrice?.restOfWorldPrice ?? product.restOfWorldPrice,
            insurancePrices: (() => {
              const clinicSpecific = insurancePrices.filter(
                (ip) => ip.clinicId === user.clinicId
              );
              const global = insurancePrices.filter(
                (ip) => ip.clinicId === null
              );
              const clinicCompanyIds = new Set(
                clinicSpecific.map((ip) => ip.insuranceCompany.id)
              );
              const globalOnly = global.filter(
                (ip) => !clinicCompanyIds.has(ip.insuranceCompany.id)
              );
              return [...clinicSpecific, ...globalOnly];
            })(),
            clinicProductPrices: undefined,
          };
        }),
      })),
    }));

    return c.json({ data: transformedVisits });
  } catch (_error) {
    return c.json(
      { error: "Failed to fetch patient visits" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const createConsultationNote = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.req.param();
    const visitId = Number.parseInt(id, 10);
    const parsed = consultationNoteSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const visit = await db.visit.update({
      where: { id: visitId },
      data: { consultationNote: parsed.data.consultationNote },
    });
    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });

    // Mark doctor queue entry as SERVED when consultation starts (best-effort)
    QueueIntegrationService.markQueueEntryServedForVisit(
      visitId,
      QueuePurpose.DOCTOR
    ).catch(() => {
      /* Queue integration is best-effort; do not fail consultation note flow */
    });

    return c.json(
      { success: true, message: "Consultation note added successfully", visit },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Failed to add consultation note" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const editConsultationNote = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.req.param();
    const visitId = Number.parseInt(id, 10);
    const parsed = consultationNoteSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const visit = await db.visit.update({
      where: { id: visitId },
      data: { consultationNote: parsed.data.consultationNote },
    });
    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });
    return c.json(
      {
        success: true,
        message: "Consultation note updated successfully",
        visit,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (_error) {
    return c.json(
      { error: "Failed to update consultation note" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const finalizeVisit = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.get("validatedParam");
    const visitId = Number.parseInt(id, 10);
    const data = c.get("validatedJson") as z.infer<typeof finalizeVisitSchema>;
    const { diagnosis, examConclusions, treatmentComments, followUpDate } =
      data;

    let parsedFollowUpDate: Date | undefined;
    if (followUpDate) {
      const d = parse(followUpDate, "dd/MM/yyyy", new Date());
      if (Number.isNaN(d.getTime())) {
        return c.json(
          { error: "Invalid follow-up date format. Please use DD/MM/YYYY" },
          httpCodes.BAD_REQUEST as ContentfulStatusCode
        );
      }
      parsedFollowUpDate = d;
    }

    const visit = await db.visit.findUnique({
      where: { id: visitId },
      select: {
        id: true,
        status: true,
        doctor: { select: { id: true, name: true } },
        patient: { select: { firstName: true, lastName: true } },
      },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    const currentUserId = Number(user.id);
    if (visit.doctor?.id !== currentUserId) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    const cannotFinalizeStatuses: Array<"CHECKED_IN" | "TRIAGE_COMPLETED"> = [
      VisitStatus.CHECKED_IN,
      VisitStatus.TRIAGE_COMPLETED,
    ];
    if (
      cannotFinalizeStatuses.includes(
        visit.status as (typeof cannotFinalizeStatuses)[number]
      )
    ) {
      return c.json(
        { error: "Visit cannot be finalized at this stage" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const updatedVisit = await db.visit.update({
      where: { id: visitId },
      data: {
        diagnosis,
        examConclusions,
        treatmentComments,
        followUpDate: parsedFollowUpDate,
        status: VisitStatus.FINALIZED,
      },
    });

    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });
    return c.json({
      success: "Visit finalized successfully",
      visit: updatedVisit,
    });
  } catch (_error) {
    return c.json(
      { error: "Internal Server Error" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const dischargeVisit = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.get("validatedParam");
    const visitId = Number.parseInt(id, 10);

    const visit = await db.visit.findUnique({
      where: { id: visitId },
      select: {
        patient: { select: { firstName: true, lastName: true } },
        patientInsurance: {
          select: { insuranceCompany: { select: { companyName: true } } },
        },
      },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const visitPrescription = await db.prescription.findFirst({
      where: { visitId },
      select: { id: true },
    });
    const result = await dischargeVisitHelper({
      user,
      visitId,
      hasPrescription: Boolean(visitPrescription),
    });

    if ((result as { error?: string }).error) {
      return c.json(
        { error: (result as { error: string }).error },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });

    return c.json({ success: "Visit discharged successfully", result });
  } catch (_error) {
    return c.json(
      { error: "Failed to discharge visit" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

export const updateVisitStatus = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.req.param();
    const visitId = Number.parseInt(id, 10);
    const parsed = updateVisitStatusSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const { status } = parsed.data;

    const updated = await db.visit.update({
      where: { id: visitId },
      data: { status },
    });
    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
      doctorId: updated.doctorId || undefined,
    });
    return c.json({
      success: "Visit status updated successfully",
      visit: updated,
    });
  } catch (_error) {
    return c.json(
      { error: "Failed to update visit status" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
export const editChiefComplaint = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.req.param();
    const visitId = Number.parseInt(id, 10);
    const parsed = editChiefComplaintSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const visit = await db.visit.findUnique({
      where: { id: visitId },
      select: { id: true, chiefComplaint: true, doctorId: true },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (visit.doctorId !== Number(user.id)) {
      return c.json(
        { error: "Unauthorized" },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }
    const updated = await db.visit.update({
      where: { id: visitId },
      data: { chiefComplaint: parsed.data.chiefComplaint },
    });

    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId,
    });

    return c.json(
      {
        success: true,
        message: "Chief complaint updated successfully",
        visit: updated,
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
