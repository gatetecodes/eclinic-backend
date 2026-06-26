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
  CARE_STAGE_ORDER,
  isOptionalStage,
  STAGE_CLASS,
  STAGE_TARGET_STATUS,
} from "../../../../lib/care-stage";
import {
  canonicalFlow,
  invalidateClinicFlowCache,
  type ResolvedFlow,
  resolveClinicFlow,
} from "../../../../lib/clinic-flow";
import { getScope } from "../../../../lib/request-scope";
import { emitFlowUpdate } from "../../../../services/flow-events.service";
import { QueueIntegrationService } from "../../../../services/queue-integration.service";
import {
  advanceVisitSchema,
  flowCheckInSchema,
  type IFlowConfigUpdate,
} from "../visits.validation";

/**
 * Resolves the active care flow for a scope. A concrete clinic resolves its
 * per-clinic config (cached); when there is no clinic in scope (e.g. a
 * super-admin viewing all clinics) we fall back to the canonical all-stages
 * flow.
 */
const flowForScope = (
  clinicId?: number,
  branchId?: number | null
): Promise<ResolvedFlow> =>
  typeof clinicId === "number"
    ? resolveClinicFlow(clinicId, branchId)
    : Promise.resolve(canonicalFlow());

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

    const flow = await flowForScope(
      typeof clinicId === "number" ? clinicId : undefined,
      typeof branchId === "number" ? branchId : undefined
    );

    const byStage = new Map<CareStage, ReturnType<typeof toFlowVisit>[]>();
    for (const stage of flow.order) {
      byStage.set(stage, []);
    }
    for (const v of visits) {
      // Safety: a visit parked at a stage the clinic has since disabled (e.g.
      // TRIAGE turned off while a patient was in triage) must still surface, so
      // create a bucket on demand rather than dropping the patient.
      if (!byStage.has(v.careStage)) {
        byStage.set(v.careStage, []);
      }
      byStage.get(v.careStage)?.push(toFlowVisit(v));
    }

    // Render in the clinic's flow order, then append any extra stages that only
    // exist because of in-flight visits at a now-disabled stage.
    const extraStages = [...byStage.keys()].filter(
      (s) => !flow.order.includes(s)
    );
    const stages = [...flow.order, ...extraStages].map((stage) => {
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
    if (!Number.isFinite(visitId)) {
      return c.json(
        { error: "Invalid visit id" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const { clinicId, branchId } = getScope(user, c.req.query());
    const visit = await db.visit.findFirst({
      where: {
        id: visitId,
        ...(typeof clinicId === "number" ? { clinicId } : {}),
        ...(typeof branchId === "number" ? { branchId } : {}),
      },
      select: {
        id: true,
        status: true,
        careStage: true,
        doctorId: true,
        clinicId: true,
        branchId: true,
      },
    });
    if (!visit) {
      return c.json(
        { error: "Visit not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    const flow = await flowForScope(visit.clinicId, visit.branchId);
    return c.json({
      visitId: visit.id,
      status: visit.status,
      stage: visit.careStage,
      allowedStages: flow.transitions[visit.careStage] ?? [],
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
 * Reception check-in for the new flow: registers/attaches the patient and
 * records payment mode. No consultation charge (created at finalize). The visit
 * then moves to the clinic's first post-reception stage — Triage when enabled,
 * otherwise straight to the Doctor, in which case the doctor + department (which
 * triage would normally assign) must be provided here.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: linear check-in with a few additive branches
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
    const {
      patient,
      selectedPatientId,
      paymentMode,
      insurance,
      priority,
      departmentId,
      doctorId,
    } = parsed.data;

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

    // Route to the clinic's first station after Reception. With Triage enabled
    // that's TRIAGE (status IN_PRE_CONSULTATION); a triage-less clinic sends the
    // patient straight to the doctor, ready for consultation (TRIAGE_COMPLETED).
    const flow = await resolveClinicFlow(user.clinicId, user.branchId);
    const firstStage = flow.firstAfterReception;
    const goingStraightToDoctor = firstStage === CareStage.DOCTOR;

    // When the clinic has no triage stage, the doctor/department assignment that
    // triage normally performs must happen here at reception — so both are
    // required to check in. (With triage enabled they're assigned later.)
    if (goingStraightToDoctor && !(doctorId && departmentId)) {
      return c.json(
        {
          error:
            "A doctor and department must be assigned at reception because this clinic has no triage stage.",
        },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const checkInStatus = goingStraightToDoctor
      ? VisitStatus.TRIAGE_COMPLETED
      : VisitStatus.IN_PRE_CONSULTATION;
    const assignedDoctorId = doctorId ? Number.parseInt(doctorId, 10) : null;
    const assignedDeptId = departmentId
      ? Number.parseInt(departmentId, 10)
      : null;

    const visit = await db.visit.create({
      data: {
        patient: { connect: { id: patientId } },
        status: checkInStatus,
        careStage: firstStage,
        priority: priority ?? Priority.LOW,
        isNewPatient,
        requiresConsultation: true,
        clinic: { connect: { id: user.clinicId } },
        ...(user.branchId
          ? { branch: { connect: { id: user.branchId } } }
          : {}),
        checkedInBy: { connect: { id: Number(user.id) } },
        paymentMode: paymentMode as PaymentMode | undefined,
        ...(assignedDeptId
          ? { department: { connect: { id: assignedDeptId } } }
          : {}),
        ...(assignedDoctorId
          ? { doctor: { connect: { id: assignedDoctorId } } }
          : {}),
        ...(patientInsuranceId
          ? { patientInsurance: { connect: { id: patientInsuranceId } } }
          : {}),
      },
      select: flowVisitSelect,
    });

    if (typeof user.branchId === "number") {
      await syncQueueForStage(firstStage, {
        visitId: visit.id,
        patientId,
        clinicId: user.clinicId,
        branchId: user.branchId,
        doctorId: assignedDoctorId,
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
      toStage: firstStage,
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
    if (!Number.isFinite(visitId)) {
      return c.json(
        { error: "Invalid visit id" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
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

    const flow = await flowForScope(visit.clinicId, visit.branchId);
    const allowedStages = flow.transitions[visit.careStage] ?? [];
    if (!allowedStages.includes(targetStage)) {
      return c.json(
        {
          error: `Cannot move a visit from ${visit.careStage} to ${targetStage}.`,
          allowedStages,
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

/** Serializes a clinic's care flow as a per-stage config the admin UI renders. */
const toFlowConfigView = (flow: ResolvedFlow) =>
  CARE_STAGE_ORDER.map((stage) => ({
    stage,
    stageClass: STAGE_CLASS[stage],
    // Only `configurable` stages expose a real toggle in the UI; the rest are
    // shown locked (mandatory) or "automatic" (conditional, data-driven).
    configurable: isOptionalStage(stage),
    enabled: isOptionalStage(stage)
      ? !flow.disabledOptional.includes(stage)
      : true,
  }));

/**
 * GET /visits/flow/config
 * The clinic's care-flow configuration: every stage with its class and whether
 * it is enabled. Admin-only (gated at the route via the `clinics` resource).
 */
export const getFlowConfig = async (c: Context) => {
  try {
    const user = c.get("user");
    const { clinicId, branchId } = getScope(user, c.req.query());
    if (typeof clinicId !== "number") {
      return c.json(
        { error: "A clinic must be in scope to read flow configuration." },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }
    const flow = await resolveClinicFlow(clinicId, branchId);
    return c.json({ clinicId, stages: toFlowConfigView(flow) });
  } catch (_error) {
    return c.json(
      { error: "Failed to load flow configuration" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};

/**
 * PUT /visits/flow/config
 * Enable/disable optional stages for the caller's clinic (clinic-wide; branch
 * overrides are not exposed in phase 1). Only OPTIONAL stages may be toggled —
 * any attempt to flip a mandatory/conditional stage is rejected so the billing
 * gates and pipeline invariants can never be configured away.
 */
export const updateFlowConfig = async (c: Context) => {
  try {
    const user = c.get("user");
    const { clinicId } = getScope(user, c.req.query());
    if (typeof clinicId !== "number") {
      return c.json(
        { error: "A clinic must be in scope to update flow configuration." },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const payload = c.get("validatedJson") as IFlowConfigUpdate;

    // Reject toggles on stages the engine owns — only optional stages vary.
    const illegal = payload.stages.filter(
      (s) => !isOptionalStage(s.stage as CareStage)
    );
    if (illegal.length > 0) {
      return c.json(
        {
          error: `These stages cannot be configured: ${illegal
            .map((s) => `${s.stage} (${STAGE_CLASS[s.stage as CareStage]})`)
            .join(", ")}. Only optional stages can be enabled or disabled.`,
        },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    // Serialize clinic-wide config writes per clinic so updateMany + create
    // cannot race for branchId = null rows under concurrent requests.
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT id
        FROM "Clinic"
        WHERE id = ${clinicId}
        FOR UPDATE
      `;

      for (const { stage, enabled } of payload.stages) {
        const stageEnum = stage as CareStage;
        const res = await tx.clinicFlowConfig.updateMany({
          where: { clinicId, branchId: null, stage: stageEnum },
          data: { enabled },
        });
        if (res.count === 0) {
          await tx.clinicFlowConfig.create({
            data: {
              clinicId,
              branchId: null,
              stage: stageEnum,
              enabled,
              position: CARE_STAGE_ORDER.indexOf(stageEnum),
            },
          });
        }
      }
    });

    await invalidateClinicFlowCache(clinicId);

    const flow = await resolveClinicFlow(clinicId);
    return c.json({
      success: true,
      message: "Flow configuration updated.",
      clinicId,
      stages: toFlowConfigView(flow),
    });
  } catch (_error) {
    return c.json(
      { error: "Failed to update flow configuration" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
