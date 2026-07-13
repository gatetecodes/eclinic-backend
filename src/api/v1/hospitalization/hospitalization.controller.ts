import { differenceInCalendarDays } from "date-fns";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  ActivityType,
  type AdmissionSource,
  type AdmissionStatus,
  type BedClass,
  BedStatus,
  type Hospitalization,
  type MedicationRoute,
  type PatientInsurance,
  PaymentMode,
  PaymentType,
  type Prisma,
  type ProgressNoteType,
  VisitStatus,
  type WardChargeCategory,
  type WardOrderCategory,
} from "../../../../generated/prisma/client";
import { db } from "../../../database/db";
import { logActivity } from "../../../helpers/activity-helpers";
import { buildQueryOptions } from "../../../helpers/query-helper";
import { searchParamsSchema } from "../../../lib/common-validation";
import { httpCodes } from "../../../lib/constants";
import { getScope } from "../../../lib/request-scope";
import { computeEws } from "./ews";
import {
  bedLabel,
  buildMarSchedule,
  groupCharges,
  REVIEW_CHARGE,
} from "./helpers";

type ProductDetailsT = {
  productName: string;
  amount: number;
  patientAmount: number;
  insuranceAmount: number;
};

const calculateShares = (
  totalCost: number,
  patientInsurance: PatientInsurance | null,
  covered: boolean
) => {
  if (!(patientInsurance && covered)) {
    return { patientShare: totalCost, insuranceShare: 0 };
  }
  const coveragePercentage = Number(patientInsurance.coveragePercentage);
  const insuranceShare = totalCost * (coveragePercentage / 100);
  const patientShare = totalCost - insuranceShare;
  return { patientShare, insuranceShare };
};

const serverError = (c: Context, error: unknown) =>
  c.json(
    { error: error instanceof Error ? error.message : "Internal server error" },
    httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
  );

const clinicScope = (user: {
  clinicId?: number | null;
  clinic?: { id?: number };
  branchId?: number | null;
  branch?: { id?: number };
}) => ({
  clinicId: (user.clinicId ?? user.clinic?.id) as number,
  branchId: user.branchId ?? user.branch?.id ?? null,
});

// ---------------------------------------------------------------------------
// Charge ledger utilities
// ---------------------------------------------------------------------------

// Bed & nursing posts one charge per calendar day of stay, priced from the
// occupied bed's own rate. Idempotent: only the days not yet posted are added
// (keyed on sourceId = day index).
const ensureBedDaysPosted = async (
  tx: Prisma.TransactionClient,
  admission: {
    id: number;
    admittedAt: Date;
    dischargedAt: Date | null;
    wardName: string;
    dailyRate: Prisma.Decimal | number;
  }
) => {
  const end = admission.dischargedAt ?? new Date();
  const days = differenceInCalendarDays(end, admission.admittedAt) + 1;
  const posted = await tx.wardCharge.count({
    where: { hospitalizationId: admission.id, category: "BED" },
  });
  const rate = Number(admission.dailyRate);
  for (let day = posted + 1; day <= days; day++) {
    await tx.wardCharge.create({
      data: {
        hospitalizationId: admission.id,
        category: "BED",
        label: `Bed & nursing — ${admission.wardName}`,
        detail: `Day ${day} × ${rate.toLocaleString("en-US")} FRw · incl. vitals rounds`,
        amount: rate,
        sourceType: "bedDay",
        sourceId: String(day),
      },
    });
  }
};

// ---------------------------------------------------------------------------
// Bed board / KPIs
// ---------------------------------------------------------------------------

export const getBoard = async (c: Context) => {
  try {
    const user = c.get("user");
    const { clinicId, branchId } = getScope(user, c.req.query());

    const wards = await db.ward.findMany({
      where: {
        ...(typeof clinicId === "number" ? { clinicId } : {}),
        ...(typeof branchId === "number" ? { branchId } : {}),
      },
      include: { beds: { orderBy: { number: "asc" } } },
      orderBy: { id: "asc" },
    });

    const admissions = await db.hospitalization.findMany({
      where: {
        dischargedAt: null,
        ...(typeof clinicId === "number" ? { clinicId } : {}),
        ...(typeof branchId === "number" ? { branchId } : {}),
      },
      select: {
        id: true,
        bedId: true,
        wardId: true,
        status: true,
        source: true,
        admittedAt: true,
        admittingDiagnosis: true,
        attending: { select: { id: true, name: true } },
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            gender: true,
            dateOfBirth: true,
          },
        },
      },
      orderBy: { admittedAt: "desc" },
    });

    const byBed = new Map(admissions.map((a) => [a.bedId, a]));
    const totalBeds = wards.reduce((s, w) => s + w.beds.length, 0);
    const occupied = admissions.length;
    const availableBeds = wards
      .flatMap((w) => w.beds)
      .filter((b) => b.status === BedStatus.AVAILABLE).length;
    const today = new Date();

    return c.json(
      {
        kpis: {
          totalBeds,
          occupied,
          available: availableBeds,
          occupancyPct: totalBeds
            ? Math.round((occupied / totalBeds) * 100)
            : 0,
          critical: admissions.filter((a) => a.status === "CRITICAL").length,
          admittedToday: admissions.filter(
            (a) => differenceInCalendarDays(today, a.admittedAt) === 0
          ).length,
          improving: admissions.filter(
            (a) => a.status === "IMPROVING" || a.status === "FOR_DISCHARGE"
          ).length,
        },
        wards: wards.map((w) => ({
          id: w.id,
          name: w.name,
          wardType: w.wardType,
          accent: w.accent,
          dailyRate: Number(w.dailyRate),
          beds: w.beds.map((b) => ({
            id: b.id,
            number: b.number,
            label: b.label,
            class: b.class,
            dailyRate: Number(b.dailyRate),
            status: b.status,
            admission: byBed.get(b.id) ?? null,
          })),
        })),
        admissions,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return serverError(c, error);
  }
};

// ---------------------------------------------------------------------------
// Wards & beds administration
// ---------------------------------------------------------------------------

export const getWards = async (c: Context) => {
  try {
    const user = c.get("user");
    const { clinicId, branchId } = getScope(user, c.req.query());
    const wards = await db.ward.findMany({
      where: {
        ...(typeof clinicId === "number" ? { clinicId } : {}),
        ...(typeof branchId === "number" ? { branchId } : {}),
      },
      include: { beds: { orderBy: { number: "asc" } } },
      orderBy: { id: "asc" },
    });
    return c.json({ data: wards }, httpCodes.OK as ContentfulStatusCode);
  } catch (error) {
    return serverError(c, error);
  }
};

export const createWard = async (c: Context) => {
  try {
    const user = c.get("user");
    const { name, wardType, accent, dailyRate, bedCount } =
      c.get("validatedJson");
    const { clinicId, branchId } = clinicScope(user);

    const ward = await db.$transaction(async (tx) => {
      const created = await tx.ward.create({
        data: { name, wardType, accent, dailyRate, clinicId, branchId },
      });
      if (bedCount && bedCount > 0) {
        await tx.bed.createMany({
          data: Array.from({ length: bedCount }, (_, i) => ({
            wardId: created.id,
            number: i + 1,
            label: bedLabel(wardType, i + 1),
            dailyRate,
          })),
        });
      }
      return created;
    });

    return c.json(
      { success: "Ward created", data: ward },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    return serverError(c, error);
  }
};

export const updateWard = async (c: Context) => {
  try {
    const id = Number.parseInt(c.req.param("id"), 10);
    const { name, wardType, accent, dailyRate } = c.get("validatedJson");
    const ward = await db.ward.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(wardType !== undefined ? { wardType } : {}),
        ...(accent !== undefined ? { accent } : {}),
        ...(dailyRate !== undefined ? { dailyRate } : {}),
      },
    });
    return c.json(
      { success: "Ward updated", data: ward },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return serverError(c, error);
  }
};

export const addBeds = async (c: Context) => {
  try {
    const wardId = Number.parseInt(c.req.param("id"), 10);
    const { count, class: bedClass, dailyRate } = c.get("validatedJson");
    const ward = await db.ward.findUnique({ where: { id: wardId } });
    if (!ward) {
      return c.json(
        { error: "Ward not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    const rate = dailyRate ?? Number(ward.dailyRate);
    const last = await db.bed.findFirst({
      where: { wardId },
      orderBy: { number: "desc" },
    });
    const start = (last?.number ?? 0) + 1;
    await db.bed.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        wardId,
        number: start + i,
        label: bedLabel(ward.wardType, start + i),
        class: (bedClass ?? "STANDARD") as BedClass,
        dailyRate: rate,
      })),
    });
    return c.json(
      { success: `${count} bed(s) added` },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    return serverError(c, error);
  }
};

export const updateBed = async (c: Context) => {
  try {
    const id = Number.parseInt(c.req.param("id"), 10);
    const { status } = c.get("validatedJson");
    const bed = await db.bed.update({ where: { id }, data: { status } });
    return c.json(
      { success: "Bed updated", data: bed },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return serverError(c, error);
  }
};

// ---------------------------------------------------------------------------
// Admissions roster + chart
// ---------------------------------------------------------------------------

export const getHospitalizations = async (c: Context) => {
  try {
    const user = c.get("user");
    const params = searchParamsSchema.parse(c.req.query());
    const { clinicId, branchId } = getScope(user, params);
    const queryOptions = buildQueryOptions<Hospitalization>(params, {
      ...(typeof clinicId === "number" ? { clinicId } : {}),
      ...(typeof branchId === "number" ? { branchId } : {}),
    });
    const { where, orderBy, ...restOptions } = queryOptions;
    const hospitalizations = await db.hospitalization.findMany({
      where: where as Prisma.HospitalizationWhereInput,
      orderBy: orderBy as Prisma.HospitalizationOrderByWithRelationInput,
      ...restOptions,
      select: {
        id: true,
        status: true,
        source: true,
        admittedAt: true,
        dischargedAt: true,
        admittingDiagnosis: true,
        admittingIcdCode: true,
        estimatedStayDays: true,
        ward: { select: { id: true, name: true, accent: true } },
        bed: { select: { id: true, label: true, class: true } },
        attending: { select: { id: true, name: true } },
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
            gender: true,
            dateOfBirth: true,
          },
        },
        visit: { select: { id: true, status: true } },
      },
    });
    const totalCount = await db.hospitalization.count({
      where: where as Prisma.HospitalizationWhereInput,
    });
    const pageCount = restOptions.take
      ? Math.ceil(totalCount / restOptions.take)
      : 0;
    return c.json(
      { data: hospitalizations, totalCount, pageCount },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return serverError(c, error);
  }
};

export const getAdmission = async (c: Context) => {
  try {
    const id = Number.parseInt(c.req.param("id"), 10);
    // Lazily post any outstanding bed-days so the bill is current on open.
    const base = await db.hospitalization.findUnique({
      where: { id },
      select: {
        id: true,
        admittedAt: true,
        dischargedAt: true,
        ward: { select: { name: true } },
        bed: { select: { dailyRate: true } },
      },
    });
    if (!base) {
      return c.json(
        { error: "Admission not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (!base.dischargedAt) {
      await db.$transaction((tx) =>
        ensureBedDaysPosted(tx, {
          id: base.id,
          admittedAt: base.admittedAt,
          dischargedAt: base.dischargedAt,
          wardName: base.ward.name,
          dailyRate: base.bed.dailyRate,
        })
      );
    }

    // Assembled from several shallow queries rather than one deeply-nested
    // include — Prisma 7's result-type inference blows the compiler's limits on
    // 4-level includes.
    const [
      admission,
      observations,
      medications,
      progressNotes,
      orders,
      bedTransfers,
      charges,
      dischargeSummary,
    ] = await Promise.all([
      db.hospitalization.findUnique({
        where: { id },
        include: {
          ward: true,
          bed: true,
          patient: true,
          attending: { select: { id: true, name: true } },
          visit: {
            select: {
              id: true,
              status: true,
              chiefComplaint: true,
              patientInsuranceId: true,
            },
          },
        },
      }),
      db.wardObservation.findMany({
        where: { hospitalizationId: id },
        orderBy: { recordedAt: "desc" },
        take: 24,
      }),
      db.wardMedication.findMany({
        where: { hospitalizationId: id },
        orderBy: { createdAt: "asc" },
        include: { administrations: { orderBy: { scheduledAt: "asc" } } },
      }),
      db.progressNote.findMany({
        where: { hospitalizationId: id },
        orderBy: { createdAt: "desc" },
        include: { author: { select: { id: true, name: true } } },
      }),
      db.wardOrder.findMany({
        where: { hospitalizationId: id },
        orderBy: { orderedAt: "desc" },
      }),
      db.bedTransfer.findMany({
        where: { hospitalizationId: id },
        orderBy: { createdAt: "desc" },
      }),
      db.wardCharge.findMany({
        where: { hospitalizationId: id },
        orderBy: { postedAt: "asc" },
      }),
      db.dischargeSummary.findUnique({ where: { hospitalizationId: id } }),
    ]);

    if (!admission) {
      return c.json(
        { error: "Admission not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    const insurance = admission.visit.patientInsuranceId
      ? await db.patientInsurance.findUnique({
          where: { id: admission.visit.patientInsuranceId },
          include: { insuranceCompany: { select: { name: true } } },
        })
      : null;

    const { groups, subtotal } = groupCharges(charges);
    const covered = admission.roomCoveredByInsurance || !!insurance;
    const { patientShare, insuranceShare } = calculateShares(
      subtotal,
      insurance,
      covered
    );

    return c.json(
      {
        data: {
          ...admission,
          observations,
          medications,
          progressNotes,
          orders,
          bedTransfers,
          charges,
          dischargeSummary,
          insurance,
          bill: {
            groups,
            subtotal,
            insuranceAmount: insuranceShare,
            patientAmount: patientShare,
            coveragePercentage: insurance
              ? Number(insurance.coveragePercentage)
              : 0,
            insurerName: insurance?.insuranceCompany?.name ?? "Self-pay",
            itemCount: charges.length,
          },
        },
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return serverError(c, error);
  }
};

// ---------------------------------------------------------------------------
// Admit
// ---------------------------------------------------------------------------

const placeBed = async (
  tx: Prisma.TransactionClient,
  wardId: number,
  requestedBedId?: number
) => {
  if (requestedBedId) {
    const bed = await tx.bed.findUnique({ where: { id: requestedBedId } });
    if (!bed || bed.wardId !== wardId) {
      throw new Error("Selected bed is not in the chosen ward");
    }
    if (bed.status !== BedStatus.AVAILABLE) {
      throw new Error("Selected bed is not available");
    }
    return bed;
  }
  const bed = await tx.bed.findFirst({
    where: { wardId, status: BedStatus.AVAILABLE },
    orderBy: { number: "asc" },
  });
  if (!bed) {
    throw new Error("No available bed in the selected ward");
  }
  return bed;
};

export const admitPatient = async (c: Context) => {
  try {
    const user = c.get("user");
    const body = c.get("validatedJson");
    const {
      visitId,
      patientId,
      wardId,
      bedId,
      attendingId,
      status,
      source,
      presentingComplaint,
      admittingDiagnosis,
      admittingIcdCode,
      estimatedStayDays,
      isRoomCoveredByInsurance,
    } = body;

    const ward = await db.ward.findUnique({ where: { id: wardId } });
    if (!ward) {
      return c.json(
        { error: "Ward not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: admission resolves a visit (existing or new), places a bed and posts opening charges in one transaction
    const result = await db.$transaction(async (tx) => {
      let resolvedVisitId = visitId as number | undefined;
      let resolvedPatientId = patientId as number | undefined;
      let clinicId = ward.clinicId;
      let branchId = ward.branchId;
      let paymentMode: PaymentMode | null = null;

      if (resolvedVisitId) {
        const visit = await tx.visit.findUnique({
          where: { id: resolvedVisitId },
          select: {
            patientId: true,
            clinicId: true,
            branchId: true,
            paymentMode: true,
          },
        });
        if (!visit) {
          throw new Error("Visit not found");
        }
        resolvedPatientId = visit.patientId;
        clinicId = visit.clinicId;
        branchId = visit.branchId;
        paymentMode = visit.paymentMode;
      } else {
        // Direct / emergency admission — create a fresh visit for the patient.
        if (!resolvedPatientId) {
          throw new Error("Either visitId or patientId is required");
        }
        const patient = await tx.patient.findUnique({
          where: { id: resolvedPatientId },
          select: {
            id: true,
            patientInsurance: {
              take: 1,
              orderBy: { createdAt: "desc" },
              select: { id: true },
            },
          },
        });
        if (!patient) {
          throw new Error("Patient not found");
        }
        // Direct/emergency admissions are scoped to the ward's clinic/branch.
        clinicId = ward.clinicId;
        branchId = ward.branchId;
        const insuranceId = patient.patientInsurance[0]?.id ?? null;
        paymentMode = insuranceId ? PaymentMode.INSURANCE : PaymentMode.PRIVATE;
        const visit = await tx.visit.create({
          data: {
            patientId: resolvedPatientId,
            clinicId,
            branchId,
            status: VisitStatus.ADMITTED,
            careStage: "DOCTOR",
            priority: "HIGH",
            paymentMode,
            requiresConsultation: false,
            chiefComplaint: presentingComplaint ?? null,
            patientInsuranceId: insuranceId,
          },
          select: { id: true },
        });
        resolvedVisitId = visit.id;
      }

      const bed = await placeBed(tx, wardId, bedId);

      const admission = await tx.hospitalization.create({
        data: {
          visitId: resolvedVisitId as number,
          patientId: resolvedPatientId as number,
          clinicId,
          branchId,
          wardId,
          bedId: bed.id,
          attendingId: attendingId ?? null,
          status: (status ?? "STABLE") as AdmissionStatus,
          source: (source ?? "CONSULTATION") as AdmissionSource,
          presentingComplaint: presentingComplaint ?? null,
          admittingDiagnosis: admittingDiagnosis ?? null,
          admittingIcdCode: admittingIcdCode ?? null,
          estimatedStayDays: estimatedStayDays ?? null,
          roomCoveredByInsurance: !!isRoomCoveredByInsurance,
        },
        include: { ward: true },
      });

      await tx.bed.update({
        where: { id: bed.id },
        data: { status: BedStatus.OCCUPIED },
      });
      await tx.visit.update({
        where: { id: resolvedVisitId as number },
        data: { status: VisitStatus.ADMITTED },
      });
      await tx.payment.create({
        data: {
          visitId: resolvedVisitId as number,
          clinicId,
          branchId,
          amount: 0,
          patientAmount: 0,
          insuranceAmount: 0,
          paymentType: PaymentType.HOSPITALIZATION,
          paymentMode: (paymentMode ?? PaymentMode.PRIVATE) as PaymentMode,
        },
      });
      if (admittingDiagnosis) {
        await tx.visitDiagnosis.create({
          data: {
            visitId: resolvedVisitId as number,
            description: admittingDiagnosis,
            icd11Code: admittingIcdCode ?? null,
            isPrimary: true,
          },
        });
      }
      // First bed-day posts immediately, priced from the assigned bed.
      await ensureBedDaysPosted(tx, {
        id: admission.id,
        admittedAt: admission.admittedAt,
        dischargedAt: admission.dischargedAt,
        wardName: admission.ward.name,
        dailyRate: bed.dailyRate,
      });

      return admission;
    });

    await logActivity({
      userId: user.id,
      visitId: result.visitId,
      action: `Patient admitted to ${result.ward.name}`,
      type: ActivityType.HOSPITALIZATION,
    });

    return c.json(
      { success: "Patient admitted successfully", data: result },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    return serverError(c, error);
  }
};

// ---------------------------------------------------------------------------
// Transfer bed / ward
// ---------------------------------------------------------------------------

export const transferAdmission = async (c: Context) => {
  try {
    const user = c.get("user");
    const id = Number.parseInt(c.req.param("id"), 10);
    const { wardId, bedId, reason } = c.get("validatedJson");

    const admission = await db.hospitalization.findUnique({
      where: { id },
      select: { id: true, bedId: true, wardId: true, visitId: true },
    });
    if (!admission) {
      return c.json(
        { error: "Admission not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    const targetWardId = wardId ?? admission.wardId;

    const transfer = await db.$transaction(async (tx) => {
      const bed = await placeBed(tx, targetWardId, bedId);
      await tx.bed.update({
        where: { id: admission.bedId },
        data: { status: BedStatus.CLEANING },
      });
      await tx.bed.update({
        where: { id: bed.id },
        data: { status: BedStatus.OCCUPIED },
      });
      await tx.hospitalization.update({
        where: { id },
        data: { wardId: targetWardId, bedId: bed.id },
      });
      return tx.bedTransfer.create({
        data: {
          hospitalizationId: id,
          fromBedId: admission.bedId,
          toBedId: bed.id,
          reason: reason ?? null,
          transferredById: user.id,
        },
      });
    });

    await logActivity({
      userId: user.id,
      visitId: admission.visitId,
      action: "Patient transferred to a new bed",
      type: ActivityType.HOSPITALIZATION,
    });
    return c.json(
      { success: "Patient transferred", data: transfer },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return serverError(c, error);
  }
};

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

export const recordObservation = async (c: Context) => {
  try {
    const user = c.get("user");
    const id = Number.parseInt(c.req.param("id"), 10);
    const v = c.get("validatedJson");
    const ewsScore = computeEws({
      temperature: v.temperature,
      heartRate: v.heartRate,
      bloodPressure: v.bloodPressure,
      respiratoryRate: v.respiratoryRate,
      spo2: v.spo2,
      avpu: v.avpu,
    });
    const observation = await db.wardObservation.create({
      data: {
        hospitalizationId: id,
        temperature: v.temperature ?? null,
        heartRate: v.heartRate ?? null,
        bloodPressure: v.bloodPressure ?? null,
        respiratoryRate: v.respiratoryRate ?? null,
        spo2: v.spo2 ?? null,
        pain: v.pain ?? null,
        avpu: v.avpu ?? null,
        ewsScore,
        recordedById: user.id,
      },
    });
    return c.json(
      { success: "Observation recorded", data: observation },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    return serverError(c, error);
  }
};

// ---------------------------------------------------------------------------
// Medication administration record (MAR)
// ---------------------------------------------------------------------------

export const addMedication = async (c: Context) => {
  try {
    const user = c.get("user");
    const id = Number.parseInt(c.req.param("id"), 10);
    const v = c.get("validatedJson");
    const firstDoseAt = v.firstDoseAt ? new Date(v.firstDoseAt) : new Date();

    const medication = await db.$transaction(async (tx) => {
      const med = await tx.wardMedication.create({
        data: {
          hospitalizationId: id,
          productId: v.productId ?? null,
          drugName: v.drugName,
          dose: v.dose,
          route: v.route as MedicationRoute,
          frequency: v.frequency,
          firstDoseAt,
          pricePerDose: v.pricePerDose,
          prescribedById: user.id,
        },
      });
      const slots = buildMarSchedule(firstDoseAt, v.frequency, 4);
      if (slots.length > 0) {
        await tx.wardMedicationAdministration.createMany({
          data: slots.map((scheduledAt) => ({
            wardMedicationId: med.id,
            scheduledAt,
            status: "DUE" as const,
          })),
        });
      }
      return med;
    });

    return c.json(
      { success: "Medication added to MAR", data: medication },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    return serverError(c, error);
  }
};

export const administerMedication = async (c: Context) => {
  try {
    const user = c.get("user");
    const medId = Number.parseInt(c.req.param("medId"), 10);
    const { administrationId } = c.get("validatedJson") ?? {};

    const med = await db.wardMedication.findUnique({
      where: { id: medId },
      select: {
        id: true,
        drugName: true,
        route: true,
        pricePerDose: true,
        hospitalizationId: true,
      },
    });
    if (!med) {
      return c.json(
        { error: "Medication not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }

    await db.$transaction(async (tx) => {
      if (administrationId) {
        await tx.wardMedicationAdministration.update({
          where: { id: administrationId },
          data: {
            status: "GIVEN",
            administeredById: user.id,
            administeredAt: new Date(),
          },
        });
      } else {
        await tx.wardMedicationAdministration.create({
          data: {
            wardMedicationId: medId,
            scheduledAt: new Date(),
            status: "GIVEN",
            administeredById: user.id,
            administeredAt: new Date(),
          },
        });
      }
      const price = Number(med.pricePerDose);
      await tx.wardCharge.create({
        data: {
          hospitalizationId: med.hospitalizationId,
          category: "MEDS",
          label: med.drugName,
          detail: `1 dose given × ${price.toLocaleString("en-US")} FRw · ${med.route}`,
          amount: price,
          sourceType: "administration",
          sourceId: administrationId ? String(administrationId) : null,
        },
      });
    });

    return c.json(
      { success: "Dose administered and charge posted" },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return serverError(c, error);
  }
};

// ---------------------------------------------------------------------------
// Progress notes
// ---------------------------------------------------------------------------

const REVIEW_NOTE_TYPES: ProgressNoteType[] = [
  "WARD_ROUND",
  "CONSULTANT_REVIEW",
  "ON_CALL_REVIEW",
  "ADMISSION",
];

export const addProgressNote = async (c: Context) => {
  try {
    const user = c.get("user");
    const id = Number.parseInt(c.req.param("id"), 10);
    const { noteType, text } = c.get("validatedJson");

    const note = await db.$transaction(async (tx) => {
      const created = await tx.progressNote.create({
        data: {
          hospitalizationId: id,
          authorId: user.id,
          noteType: (noteType ?? "WARD_ROUND") as ProgressNoteType,
          text,
        },
      });
      if (REVIEW_NOTE_TYPES.includes(created.noteType)) {
        await tx.wardCharge.create({
          data: {
            hospitalizationId: id,
            category: "REVIEW",
            label: "Ward round / clinician review",
            detail: `${REVIEW_CHARGE.toLocaleString("en-US")} FRw`,
            amount: REVIEW_CHARGE,
            sourceType: "progressNote",
            sourceId: String(created.id),
          },
        });
      }
      return created;
    });

    return c.json(
      { success: "Progress note added", data: note },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    return serverError(c, error);
  }
};

// ---------------------------------------------------------------------------
// Orders & labs
// ---------------------------------------------------------------------------

export const orderTest = async (c: Context) => {
  try {
    const user = c.get("user");
    const id = Number.parseInt(c.req.param("id"), 10);
    const { investigation, category, price } = c.get("validatedJson");
    const cat = (category ?? "LAB") as WardOrderCategory;
    const amount = price ?? (cat === "IMAGING" ? 15_000 : 4000);

    const order = await db.$transaction(async (tx) => {
      const created = await tx.wardOrder.create({
        data: {
          hospitalizationId: id,
          investigation,
          category: cat,
          price: amount,
          orderedById: user.id,
        },
      });
      await tx.wardCharge.create({
        data: {
          hospitalizationId: id,
          category: cat as WardChargeCategory,
          label: investigation,
          detail: "Ordered · pending",
          amount,
          sourceType: "order",
          sourceId: String(created.id),
        },
      });
      return created;
    });

    return c.json(
      { success: "Investigation ordered", data: order },
      httpCodes.CREATED as ContentfulStatusCode
    );
  } catch (error) {
    return serverError(c, error);
  }
};

export const updateOrder = async (c: Context) => {
  try {
    const orderId = Number.parseInt(c.req.param("orderId"), 10);
    const { status, result, resultSeverity } = c.get("validatedJson");
    const order = await db.wardOrder.update({
      where: { id: orderId },
      data: {
        ...(status !== undefined ? { status } : {}),
        ...(result !== undefined ? { result } : {}),
        ...(resultSeverity !== undefined ? { resultSeverity } : {}),
        ...(status === "RESULTED" ? { resultedAt: new Date() } : {}),
      },
    });
    return c.json(
      { success: "Order updated", data: order },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return serverError(c, error);
  }
};

// ---------------------------------------------------------------------------
// Bill
// ---------------------------------------------------------------------------

export const getBill = async (c: Context) => {
  try {
    const id = Number.parseInt(c.req.param("id"), 10);
    const admission = await db.hospitalization.findUnique({
      where: { id },
      select: {
        id: true,
        admittedAt: true,
        dischargedAt: true,
        roomCoveredByInsurance: true,
        ward: { select: { name: true } },
        bed: { select: { dailyRate: true } },
        visit: { select: { patientInsuranceId: true } },
      },
    });
    if (!admission) {
      return c.json(
        { error: "Admission not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (!admission.dischargedAt) {
      await db.$transaction((tx) =>
        ensureBedDaysPosted(tx, {
          id: admission.id,
          admittedAt: admission.admittedAt,
          dischargedAt: admission.dischargedAt,
          wardName: admission.ward.name,
          dailyRate: admission.bed.dailyRate,
        })
      );
    }
    const charges = await db.wardCharge.findMany({
      where: { hospitalizationId: id },
      orderBy: { postedAt: "asc" },
    });
    const insurance = admission.visit.patientInsuranceId
      ? await db.patientInsurance.findUnique({
          where: { id: admission.visit.patientInsuranceId },
          include: { insuranceCompany: { select: { name: true } } },
        })
      : null;
    const { groups, subtotal } = groupCharges(charges);
    const covered = admission.roomCoveredByInsurance || !!insurance;
    const { patientShare, insuranceShare } = calculateShares(
      subtotal,
      insurance,
      covered
    );
    return c.json(
      {
        data: {
          groups,
          subtotal,
          insuranceAmount: insuranceShare,
          patientAmount: patientShare,
          coveragePercentage: insurance
            ? Number(insurance.coveragePercentage)
            : 0,
          insurerName: insurance?.insuranceCompany?.name ?? "Self-pay",
          itemCount: charges.length,
        },
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return serverError(c, error);
  }
};

// ---------------------------------------------------------------------------
// Discharge
// ---------------------------------------------------------------------------

export const dischargePatient = async (c: Context) => {
  try {
    const user = c.get("user");
    const id = Number.parseInt(c.req.param("id"), 10);
    const summary = c.get("validatedJson") ?? {};

    const admission = await db.hospitalization.findUnique({
      where: { id },
      select: {
        id: true,
        bedId: true,
        visitId: true,
        admittedAt: true,
        dischargedAt: true,
        roomCoveredByInsurance: true,
        ward: { select: { name: true } },
        bed: { select: { dailyRate: true } },
        patient: { select: { firstName: true, lastName: true } },
        visit: { select: { patientInsuranceId: true } },
      },
    });
    if (!admission) {
      return c.json(
        { error: "Admission not found" },
        httpCodes.NOT_FOUND as ContentfulStatusCode
      );
    }
    if (admission.dischargedAt) {
      return c.json(
        { error: "Patient already discharged" },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const patientInsurance = admission.visit.patientInsuranceId
      ? await db.patientInsurance.findUnique({
          where: { id: admission.visit.patientInsuranceId },
        })
      : null;
    const payment = await db.payment.findFirst({
      where: {
        visitId: admission.visitId,
        paymentType: PaymentType.HOSPITALIZATION,
      },
      orderBy: { createdAt: "desc" },
    });

    await db.$transaction(async (tx) => {
      await ensureBedDaysPosted(tx, {
        id: admission.id,
        admittedAt: admission.admittedAt,
        dischargedAt: admission.dischargedAt,
        wardName: admission.ward.name,
        dailyRate: admission.bed.dailyRate,
      });
      const charges = await tx.wardCharge.findMany({
        where: { hospitalizationId: id },
      });
      const { groups, subtotal } = groupCharges(charges);
      const covered = admission.roomCoveredByInsurance || !!patientInsurance;
      const { patientShare, insuranceShare } = calculateShares(
        subtotal,
        patientInsurance,
        covered
      );
      const paymentDetails: ProductDetailsT[] = groups.map((g) => {
        const share = calculateShares(g.total, patientInsurance, covered);
        return {
          productName: g.category,
          amount: g.total,
          patientAmount: share.patientShare,
          insuranceAmount: share.insuranceShare,
        };
      });

      if (payment) {
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            amount: subtotal,
            patientAmount: patientShare,
            insuranceAmount: insuranceShare,
            paymentDetails,
          },
        });
      }

      await tx.dischargeSummary.upsert({
        where: { hospitalizationId: id },
        update: {
          finalDiagnosis: summary.finalDiagnosis ?? null,
          summary: summary.summary ?? null,
          followUpDate: summary.followUpDate
            ? new Date(summary.followUpDate)
            : null,
          destination: summary.destination ?? "HOME",
          patientInstructions: summary.patientInstructions ?? null,
          dischargedById: user.id,
        },
        create: {
          hospitalizationId: id,
          finalDiagnosis: summary.finalDiagnosis ?? null,
          summary: summary.summary ?? null,
          followUpDate: summary.followUpDate
            ? new Date(summary.followUpDate)
            : null,
          destination: summary.destination ?? "HOME",
          patientInstructions: summary.patientInstructions ?? null,
          dischargedById: user.id,
        },
      });

      await tx.hospitalization.update({
        where: { id },
        data: { dischargedAt: new Date(), status: "FOR_DISCHARGE" },
      });
      await tx.bed.update({
        where: { id: admission.bedId },
        data: { status: BedStatus.CLEANING },
      });
      await tx.visit.update({
        where: { id: admission.visitId },
        data: { status: VisitStatus.DISCHARGED, endTime: new Date() },
      });
    });

    await logActivity({
      userId: user.id,
      visitId: admission.visitId,
      action: `Patient ${admission.patient.firstName} ${admission.patient.lastName} discharged from ${admission.ward.name}`,
      type: ActivityType.HOSPITALIZATION,
    });
    return c.json(
      { success: "Patient discharged successfully" },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    return serverError(c, error);
  }
};
