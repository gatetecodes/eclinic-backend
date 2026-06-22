import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "@/lib/constants";
import {
  CareStage,
  type PaymentMode,
  PaymentStatus,
  PaymentType,
  Priority,
  type Prisma,
  QueuePurpose,
  Role,
  VisitStatus,
} from "../../../../../generated/prisma/client";
import { db } from "../../../../database/db";
import {
  getOrCreatePatient,
  handleInsurance,
} from "../../../../helpers/visit-helper";
import { invalidateVisitRelatedCaches } from "../../../../lib/cache-utils";
import {
  ALLOWED_TRANSITIONS,
  CARE_STAGE_ORDER,
  isAllowedTransition,
  STAGE_TARGET_STATUS,
} from "../../../../lib/care-stage";
import { getScope } from "../../../../lib/request-scope";
import { emitFlowUpdate } from "../../../../services/flow-events.service";
import { QueueIntegrationService } from "../../../../services/queue-integration.service";
import { advanceVisitSchema, flowCheckInSchema } from "../visits.validation";

const ACUITY_BY_PRIORITY: Record<Priority, "Routine" | "Urgent" | "Emergency"> =
  {
    [Priority.LOW]: "Routine",
    [Priority.MEDIUM]: "Urgent",
    [Priority.HIGH]: "Emergency",
  };

const initialsOf = (first?: string | null, last?: string | null) =>
  `${first?.[0] ?? ""}${last?.[0] ?? ""}`.toUpperCase() || "?";

type FlowVisitRow = {
  id: number;
  startTime: Date;
  status: VisitStatus;
  careStage: CareStage;
  priority: Priority;
  doctorId: number | null;
  paymentMode: PaymentMode | null;
  patient: {
    firstName: string | null;
    lastName: string | null;
    phoneNumber: string | null;
    dateOfBirth: Date | null;
  } | null;
  patientInsurance: {
    coveragePercentage: Prisma.Decimal | null;
    insuranceCompany: { companyName: string | null } | null;
  } | null;
  doctor: { name: string | null } | null;
};

const toFlowVisit = (v: FlowVisitRow) => ({
  id: v.id,
  patientName:
    `${v.patient?.firstName ?? ""} ${v.patient?.lastName ?? ""}`.trim(),
  initials: initialsOf(v.patient?.firstName, v.patient?.lastName),
  phone: v.patient?.phoneNumber ?? null,
  arrived: v.startTime,
  stage: v.careStage,
  status: v.status,
  acuity: ACUITY_BY_PRIORITY[v.priority],
  provider: v.doctor?.name ?? null,
  providerId: v.doctorId,
  dateOfBirth: v.patient?.dateOfBirth ?? null,
  paymentMode: v.paymentMode ?? null,
  patientInsurance: v.patientInsurance
    ? {
        coveragePercentage:
          v.patientInsurance.coveragePercentage?.toString() ?? null,
        insuranceCompany:
          v.patientInsurance.insuranceCompany?.companyName ?? null,
      }
    : null,
});

const flowVisitSelect = {
  id: true,
  startTime: true,
  status: true,
  careStage: true,
  priority: true,
  doctorId: true,
  paymentMode: true,
  patient: {
    select: {
      firstName: true,
      lastName: true,
      phoneNumber: true,
      dateOfBirth: true,
    },
  },
  patientInsurance: {
    select: {
      coveragePercentage: true,
      insuranceCompany: { select: { companyName: true } },
    },
  },
  doctor: { select: { name: true } },
} satisfies Prisma.VisitSelect;

/**
 * GET /visits/pipeline
 * Live patient-flow snapshot grouped by CareStage. Powers the dashboard flow
 * widget and the per-stage queue screens. Active stages include all in-flight
 * visits; DONE is scoped to "completed today" so the payload stays bounded.
 */
export const getPipeline = async (c: Context) => {
  try {
    const user = c.get("user");
    const { clinicId, branchId } = getScope(user, c.req.query());

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // A doctor is only responsible for the patients assigned to them, so the
    // consultation (DOCTOR) stage is scoped to their own visits server-side —
    // the backend is the source of truth, not a client-side filter. Every other
    // stage stays clinic-wide (shared lab/pharmacy/billing/triage queues), and
    // other roles (admins, cashiers, …) see the whole pipeline.
    const doctorId = Number(user?.id);
    const scopeDoctorStage =
      user?.role === Role.DOCTOR && Number.isFinite(doctorId);

    const stageFilter: Prisma.VisitWhereInput = scopeDoctorStage
      ? {
          OR: [
            { careStage: { notIn: [CareStage.DONE, CareStage.DOCTOR] } },
            { careStage: CareStage.DOCTOR, doctorId },
            { careStage: CareStage.DONE, updatedAt: { gte: startOfToday } },
          ],
        }
      : {
          OR: [
            { careStage: { not: CareStage.DONE } },
            { careStage: CareStage.DONE, updatedAt: { gte: startOfToday } },
          ],
        };

    const where: Prisma.VisitWhereInput = {
      ...(typeof clinicId === "number" ? { clinicId } : {}),
      ...(typeof branchId === "number" ? { branchId } : {}),
      ...stageFilter,
    };

    const visits = await db.visit.findMany({
      where,
      orderBy: { startTime: "asc" },
      select: flowVisitSelect,
      take: 500,
    });

    const byStage = new Map<CareStage, ReturnType<typeof toFlowVisit>[]>();
    for (const stage of CARE_STAGE_ORDER) {
      byStage.set(stage, []);
    }
    for (const v of visits) {
      byStage.get(v.careStage)?.push(toFlowVisit(v));
    }

    const stages = CARE_STAGE_ORDER.map((stage) => {
      const list = byStage.get(stage) ?? [];
      return { stage, count: list.length, visits: list };
    });

    return c.json({
      stages,
      total: visits.length,
      updatedAt: new Date().toISOString(),
    });
  } catch (_error) {
    return c.json(
      { error: "Failed to load patient flow pipeline" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

/**
 * GET /visits/:id/stage-summary
 * Current stage + the stages this visit may legally advance to next.
 */
export const getStageSummary = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.req.param();
    const visitId = Number.parseInt(id, 10);
    const { clinicId, branchId } = getScope(user, c.req.query());
    const visit = await db.visit.findFirst({
      where: {
        id: visitId,
        ...(typeof clinicId === "number" ? { clinicId } : {}),
        ...(typeof branchId === "number" ? { branchId } : {}),
      },
      select: { id: true, status: true, careStage: true, doctorId: true },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    return c.json({
      visitId: visit.id,
      status: visit.status,
      stage: visit.careStage,
      allowedStages: ALLOWED_TRANSITIONS[visit.careStage] ?? [],
    });
  } catch (_error) {
    return c.json(
      { error: "Failed to load stage summary" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

// Best-effort queue sync for a target stage. Never blocks the transition.
const syncQueueForStage = async (
  toStage: CareStage,
  ctx: {
    visitId: number;
    patientId: number;
    clinicId: number;
    branchId: number;
    doctorId: number | null;
  }
) => {
  try {
    switch (toStage) {
      case CareStage.TRIAGE:
        await QueueIntegrationService.ensurePatientInNursePreConsultationQueue({
          patientId: ctx.patientId,
          clinicId: ctx.clinicId,
          branchId: ctx.branchId,
          visitId: ctx.visitId,
        });
        break;
      case CareStage.DOCTOR:
        if (ctx.doctorId) {
          await QueueIntegrationService.ensurePatientInDoctorQueue({
            doctorId: ctx.doctorId,
            patientId: ctx.patientId,
            clinicId: ctx.clinicId,
            branchId: ctx.branchId,
            visitId: ctx.visitId,
          });
        }
        break;
      case CareStage.LAB:
        await QueueIntegrationService.ensurePatientInLabQueue({
          patientId: ctx.patientId,
          clinicId: ctx.clinicId,
          branchId: ctx.branchId,
          visitId: ctx.visitId,
        });
        break;
      default:
        break;
    }
  } catch {
    /* queue sync is best-effort; never fail the stage transition */
  }
};

const UNSETTLED: PaymentStatus[] = [
  PaymentStatus.PENDING,
  PaymentStatus.PARTIALLY_PAID,
];

/**
 * Hard billing gates for the new flow:
 *  - Billing → Lab: the patient's exam charges must be settled first.
 *  - Billing → Pharmacy / Done (final clearance): every patient-due charge must
 *    be settled.
 * Returns an error message when the gate is not satisfied, else null.
 */
const checkBillingGate = async (
  visitId: number,
  fromStage: CareStage,
  toStage: CareStage
): Promise<string | null> => {
  if (fromStage !== CareStage.BILLING) {
    return null;
  }
  const examOnly = toStage === CareStage.LAB;
  const unpaid = await db.payment.count({
    where: {
      visitId,
      paymentStatus: { in: UNSETTLED },
      patientAmount: { gt: 0 },
      ...(examOnly ? { paymentType: PaymentType.ADDITIONAL_EXAM } : {}),
    },
  });
  if (unpaid > 0) {
    return examOnly
      ? "Exam charges must be paid before the patient can go to the lab."
      : "All charges must be settled before completing the visit.";
  }
  return null;
};

const QUEUE_PURPOSE_BY_STAGE: Partial<Record<CareStage, QueuePurpose>> = {
  [CareStage.RECEPTION]: QueuePurpose.RECEPTION,
  [CareStage.TRIAGE]: QueuePurpose.PRE_CONSULTATION,
  [CareStage.DOCTOR]: QueuePurpose.DOCTOR,
  [CareStage.LAB]: QueuePurpose.LAB,
  [CareStage.PHARMACY]: QueuePurpose.PHARMACY,
  [CareStage.BILLING]: QueuePurpose.CASHIER,
};

/**
 * POST /visits/flow/check-in
 * Slim reception check-in for the new flow: registers/attaches the patient and
 * records payment mode only. No department/doctor (assigned at triage) and no
 * consultation charge (created at finalize). Reception is just the front door:
 * once recorded, the visit moves straight into Triage & Vitals.
 */
export const createFlowCheckIn = async (c: Context) => {
  try {
    const user = c.get("user");
    const parsed = flowCheckInSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const { patient, selectedPatientId, paymentMode, insurance, priority } =
      parsed.data;

    const { patientId, isNewPatient } = await getOrCreatePatient(
      patient,
      user,
      selectedPatientId ? Number.parseInt(selectedPatientId, 10) : undefined
    );

    let patientInsuranceId: number | undefined;
    if (
      paymentMode === "INSURANCE" &&
      insurance &&
      Object.keys(insurance).length > 0
    ) {
      patientInsuranceId = await handleInsurance(
        insurance as Parameters<typeof handleInsurance>[0],
        patientId
      );
    }

    const visit = await db.visit.create({
      data: {
        patient: { connect: { id: patientId } },
        status: VisitStatus.IN_PRE_CONSULTATION,
        careStage: CareStage.TRIAGE,
        priority: priority ?? Priority.LOW,
        isNewPatient,
        requiresConsultation: true,
        clinic: { connect: { id: user.clinicId } },
        ...(user.branchId
          ? { branch: { connect: { id: user.branchId } } }
          : {}),
        checkedInBy: { connect: { id: Number(user.id) } },
        paymentMode: paymentMode as PaymentMode | undefined,
        ...(patientInsuranceId
          ? { patientInsurance: { connect: { id: patientInsuranceId } } }
          : {}),
      },
      select: flowVisitSelect,
    });

    if (typeof user.branchId === "number") {
      await syncQueueForStage(CareStage.TRIAGE, {
        visitId: visit.id,
        patientId,
        clinicId: user.clinicId,
        branchId: user.branchId,
        doctorId: null,
      });
    }

    await invalidateVisitRelatedCaches({
      clinicId: user.clinicId,
      branchId: user.branchId,
      visitId: visit.id,
    });

    const flowVisit = toFlowVisit(visit);
    emitFlowUpdate({
      clinicId: user.clinicId,
      branchId: user.branchId ?? undefined,
      type: "visit.created",
      toStage: CareStage.TRIAGE,
      visit: flowVisit,
      actorId: Number(user?.id) || undefined,
    });

    return c.json({ success: "Patient checked in", visit: flowVisit });
  } catch (_error) {
    return c.json(
      { error: "Failed to check in patient" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

/**
 * POST /visits/:id/advance
 * Atomic, validated stage transition. Writes status + careStage together,
 * keeps the queue in sync, invalidates caches and emits a live flow event.
 */

//biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
export const advanceVisitStage = async (c: Context) => {
  try {
    const user = c.get("user");
    const { id } = c.req.param();
    const visitId = Number.parseInt(id, 10);
    const { clinicId, branchId } = getScope(user, c.req.query());

    const parsed = advanceVisitSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten().fieldErrors },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const { toStage, providerId, note, withPrescription } = parsed.data;
    const targetStage = toStage as CareStage;

    const visit = await db.visit.findFirst({
      where: {
        id: visitId,
        ...(typeof clinicId === "number" ? { clinicId } : {}),
        ...(typeof branchId === "number" ? { branchId } : {}),
      },
      select: {
        id: true,
        careStage: true,
        status: true,
        clinicId: true,
        branchId: true,
        patientId: true,
        doctorId: true,
        notes: true,
      },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    if (!isAllowedTransition(visit.careStage, targetStage)) {
      return c.json(
        {
          error: `Cannot move a visit from ${visit.careStage} to ${targetStage}.`,
          allowedStages: ALLOWED_TRANSITIONS[visit.careStage] ?? [],
        },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    // Hard billing gates: block release to Lab / final completion until the
    // relevant charges are settled.
    const gateError = await checkBillingGate(
      visit.id,
      visit.careStage,
      targetStage
    );
    if (gateError) {
      return c.json(
        { error: gateError },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    // Resolve the status for the target stage (DONE can be with-prescription).
    let nextStatus = STAGE_TARGET_STATUS[targetStage];
    if (targetStage === CareStage.DONE && withPrescription) {
      nextStatus = VisitStatus.DISCHARGED_WITH_PRESCRIPTION;
    }

    const updated = await db.$transaction((tx) =>
      tx.visit.update({
        where: { id: visitId },
        data: {
          status: nextStatus,
          // careStage is set explicitly so the db extension does not override
          // ambiguous cases (e.g. PHARMACY vs BILLING both map to FINALIZED).
          careStage: targetStage,
          ...(providerId && targetStage === CareStage.DOCTOR
            ? { doctorId: providerId }
            : {}),
          ...(note
            ? { notes: visit.notes ? `${visit.notes}\n${note}` : note }
            : {}),
          ...(targetStage === CareStage.DONE ? { endTime: new Date() } : {}),
        },
        select: flowVisitSelect,
      })
    );

    // Mark the previous station's queue entry as served, best-effort. Done only
    // after the visit update commits so the queue is never marked served for a
    // transition that failed to persist.
    const prevPurpose = QUEUE_PURPOSE_BY_STAGE[visit.careStage];
    if (prevPurpose) {
      await QueueIntegrationService.markQueueEntryServedForVisit(
        visit.id,
        prevPurpose
      ).catch(() => {
        /* best-effort */
      });
    }

    if (typeof visit.branchId === "number") {
      await syncQueueForStage(targetStage, {
        visitId: visit.id,
        patientId: visit.patientId,
        clinicId: visit.clinicId,
        branchId: visit.branchId,
        doctorId: providerId ?? visit.doctorId,
      });
    }

    await invalidateVisitRelatedCaches({
      clinicId: visit.clinicId,
      branchId: visit.branchId ?? undefined,
      visitId: visit.id,
      doctorId: providerId ?? visit.doctorId ?? undefined,
    });

    const flowVisit = toFlowVisit(updated);
    emitFlowUpdate({
      clinicId: visit.clinicId,
      branchId: visit.branchId ?? undefined,
      type: "visit.advanced",
      fromStage: visit.careStage,
      toStage: targetStage,
      visit: flowVisit,
      actorId: Number(user?.id) || undefined,
    });

    return c.json({
      success: true,
      message: `Visit moved to ${targetStage}.`,
      visit: flowVisit,
    });
  } catch (_error) {
    return c.json(
      { error: "Failed to advance visit stage" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
