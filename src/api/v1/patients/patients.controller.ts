import type { Context } from "hono";
import type { Prisma } from "../../../../generated/prisma/client";
import { db } from "../../../database/db";
import type { AppEnv } from "../../../middlewares/auth.middleware";

const PATIENT_PARAM_TEST_REGEX = /^[1-9]\d*$/;

export const listPatients = async (c: Context<AppEnv>) => {
  try {
    const { page = "1", limit = "10", search = "" } = c.req.query();
    const clinicId = c.get("clinicId");
    const normalizedSearch = search.trim();

    const skip = (Number.parseInt(page, 10) - 1) * Number.parseInt(limit, 10);
    const take = Number.parseInt(limit, 10);

    const where: Prisma.PatientWhereInput = {
      clinics:
        typeof clinicId === "number" ? { some: { id: clinicId } } : undefined,
    };

    if (normalizedSearch) {
      where.OR = [
        { patientId: { contains: normalizedSearch, mode: "insensitive" } },
        { firstName: { contains: normalizedSearch, mode: "insensitive" } },
        { lastName: { contains: normalizedSearch, mode: "insensitive" } },
        { email: { contains: normalizedSearch, mode: "insensitive" } },
        { phoneNumber: { contains: normalizedSearch, mode: "insensitive" } },
        {
          guardianPhoneNumber: {
            contains: normalizedSearch,
            mode: "insensitive",
          },
        },
      ];
    }

    const [patients, total] = await Promise.all([
      db.patient.findMany({
        where,
        skip,
        take,
        include: {
          clinics: true,
          branches: true,
          // Most-recent insurance policy, used to surface the patient's insurer
          // in the registry. A patient may hold several; we expose the latest.
          patientInsurance: {
            take: 1,
            orderBy: { id: "desc" },
            include: { insuranceCompany: { select: { companyName: true } } },
          },
          visits: { take: 5, orderBy: { createdAt: "desc" } },
        },
        orderBy: { createdAt: "desc" },
      }),
      db.patient.count({ where }),
    ]);

    // Flatten the latest insurance into `insurer` / `coveragePercentage` so the
    // registry UI can render an insurer column/field without walking relations.
    const data = patients.map((patient) => {
      const policy = patient.patientInsurance?.[0];
      const { patientInsurance: _omit, ...rest } = patient;
      return {
        ...rest,
        insurer: policy?.insuranceCompany?.companyName ?? null,
        coveragePercentage:
          policy?.coveragePercentage != null
            ? Number(policy.coveragePercentage)
            : null,
      };
    });

    return c.json({
      data,
      total,
      page: Number.parseInt(page, 10),
      limit: Number.parseInt(limit, 10),
      totalPages: Math.ceil(total / Number.parseInt(limit, 10)),
    });
  } catch (_error) {
    return c.json({ error: "Internal Server Error" }, 500);
  }
};

// ---------------------------------------------------------------------------
// Patient chart (Sano design)
// ---------------------------------------------------------------------------
// A single aggregated read powering the patient chart screen. The chart's
// sections (problem list, BP trend, current meds, encounter history, care team)
// are scattered across Visit / Triage / VisitDiagnosis / Prescription /
// ExamResult, so this assembles and derives them server-side rather than making
// the client stitch several endpoints together.

type StaffRef = { id: number; name: string; role: string } | null | undefined;

const BP_SYSTOLIC_RE = /(\d{2,3})\s*\/\s*\d{2,3}/;
const FIRST_NUMBER_RE = /\d{2,3}/;
const SIXTY_DAYS = 60 * 24 * 3600 * 1000;
const CHART_VISIT_LIMIT = 100;
const CHART_VISIT_LOOKBACK_YEARS = 2;

/** Parse the systolic component out of a "120/80"-style blood-pressure string. */
const systolicOf = (bp?: string | null): number | null => {
  if (!bp) {
    return null;
  }
  const match = bp.match(BP_SYSTOLIC_RE);
  if (match) {
    return Number.parseInt(match[1], 10);
  }
  const lone = bp.match(FIRST_NUMBER_RE);
  return lone ? Number.parseInt(lone[0], 10) : null;
};

/** Allergies live free-form in Patient.medicalInfo (array or single string). */
const allergiesOf = (medicalInfo: unknown): string[] => {
  const mi =
    medicalInfo && typeof medicalInfo === "object"
      ? (medicalInfo as Record<string, unknown>)
      : {};
  const a = mi.allergies;
  if (Array.isArray(a)) {
    return a.map(String).filter(Boolean);
  }
  if (typeof a === "string" && a.trim()) {
    return [a];
  }
  return [];
};

const medicalInfoString = (
  medicalInfo: unknown,
  key: string
): string | null => {
  const mi =
    medicalInfo && typeof medicalInfo === "object"
      ? (medicalInfo as Record<string, unknown>)
      : {};
  const v = mi[key];
  return typeof v === "string" && v.trim() ? v : null;
};

/** Operational stage / status → a short, human disposition for the timeline. */
const dispositionOf = (careStage: string, status: string): string => {
  if (status === "DISCHARGED" || status === "DISCHARGED_WITH_PRESCRIPTION") {
    return "Discharged";
  }
  if (status === "ADMITTED") {
    return "Admitted";
  }
  if (status === "CANCELLED") {
    return "Cancelled";
  }
  switch (careStage) {
    case "PHARMACY":
      return "→ Pharmacy";
    case "LAB":
      return "→ Lab";
    case "BILLING":
      return "→ Billing";
    case "DOCTOR":
      return "In consultation";
    case "TRIAGE":
      return "In triage";
    case "RECEPTION":
      return "At reception";
    case "DONE":
      return "Completed";
    default:
      return status;
  }
};

/** A coarse encounter label, since visits aren't explicitly typed. */
const encounterTypeOf = (visit: {
  isLabOnly: boolean;
  department: { name: string | null } | null;
  requiresConsultation: boolean;
}): string => {
  if (visit.isLabOnly) {
    return "Lab review";
  }
  if (visit.department?.name) {
    return `${visit.department.name} consultation`;
  }
  return "Outpatient consultation";
};

/** Map a staff member's system role to a care-team label. */
const careRoleLabel = (role: string): string => {
  switch (role) {
    case "DOCTOR":
      return "Primary clinician";
    case "NURSE":
      return "Triage nurse";
    case "PHARMACIST":
      return "Pharmacist";
    case "LAB_TECHNICIAN":
      return "Lab technician";
    default:
      return role
        .toLowerCase()
        .split("_")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
  }
};

const chartVisitWindowStart = () => {
  const start = new Date();
  start.setFullYear(start.getFullYear() - CHART_VISIT_LOOKBACK_YEARS);
  return start;
};

// Relations needed to assemble the chart. Bound the visit graph to recent
// history so long-lived patients cannot load an unbounded response.
const buildChartInclude = (visitWindowStart: Date) =>
  ({
    patientInsurance: {
      take: 1,
      orderBy: { id: "desc" },
      include: { insuranceCompany: { select: { companyName: true } } },
    },
    visits: {
      where: { startTime: { gte: visitWindowStart } },
      take: CHART_VISIT_LIMIT,
      orderBy: { startTime: "desc" },
      include: {
        doctor: { select: { id: true, name: true, role: true } },
        department: { select: { name: true } },
        triage: {
          include: {
            recordedBy: { select: { id: true, name: true, role: true } },
          },
        },
        visitDiagnoses: true,
        prescriptions: {
          include: {
            doctor: { select: { id: true, name: true, role: true } },
            items: true,
          },
        },
        examResults: {
          include: {
            product: { select: { name: true, normalRange: true, unit: true } },
            exam: { select: { name: true } },
            createdBy: { select: { id: true, name: true, role: true } },
          },
        },
      },
    },
  }) satisfies Prisma.PatientInclude;

type ChartPatient = Prisma.PatientGetPayload<{
  include: ReturnType<typeof buildChartInclude>;
}>;
type ChartVisit = ChartPatient["visits"][number];

/** Most-recent systolic reading per month, oldest→newest, capped at 6 months. */
const deriveBpTrend = (visits: ChartVisit[]) => {
  const byMonth = new Map<string, { date: Date; systolic: number }>();
  for (const visit of visits) {
    const systolic = systolicOf(visit.triage?.bloodPressure);
    if (systolic == null) {
      continue;
    }
    const when = visit.triage?.createdAt ?? visit.startTime;
    const key = `${when.getFullYear()}-${when.getMonth()}`;
    const existing = byMonth.get(key);
    if (!existing || existing.date < when) {
      byMonth.set(key, { date: when, systolic });
    }
  }
  return Array.from(byMonth.values())
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .slice(-6)
    .map((p) => ({
      date: p.date,
      label: p.date.toLocaleString("en-US", { month: "short" }),
      systolic: p.systolic,
    }));
};

/** Heuristic problem status (no stored field — see endpoint docs). */
const problemStatus = (
  onLatest: boolean,
  visitCount: number,
  spanMs: number
): string => {
  if (onLatest) {
    return "Active";
  }
  if (visitCount >= 2 && spanMs > SIXTY_DAYS) {
    return "Chronic";
  }
  return "Resolved";
};

type ProblemAcc = {
  code: string | null;
  description: string;
  firstSeen: Date;
  lastSeen: Date;
  visitIds: Set<number>;
  onLatest: boolean;
};

/** Dedupe diagnoses across visits (by ICD-11 code, else description). */
const deriveProblemList = (visits: ChartVisit[]) => {
  const latestVisitId = visits[0]?.id;
  const problems = new Map<string, ProblemAcc>();
  const add = (
    code: string | null,
    description: string,
    when: Date,
    visitId: number
  ) => {
    const trimmed = description?.trim();
    if (!trimmed) {
      return;
    }
    const key = (code ?? trimmed).toLowerCase();
    const acc = problems.get(key);
    if (acc) {
      acc.firstSeen = acc.firstSeen < when ? acc.firstSeen : when;
      acc.lastSeen = acc.lastSeen > when ? acc.lastSeen : when;
      acc.visitIds.add(visitId);
      acc.onLatest = acc.onLatest || visitId === latestVisitId;
      return;
    }
    problems.set(key, {
      code,
      description: trimmed,
      firstSeen: when,
      lastSeen: when,
      visitIds: new Set([visitId]),
      onLatest: visitId === latestVisitId,
    });
  };
  for (const visit of visits) {
    if (visit.visitDiagnoses.length > 0) {
      for (const d of visit.visitDiagnoses) {
        add(d.icd11Code, d.description, visit.startTime, visit.id);
      }
    } else if (visit.diagnosis?.trim()) {
      add(null, visit.diagnosis, visit.startTime, visit.id);
    }
  }
  return Array.from(problems.values())
    .map((p) => ({
      code: p.code,
      description: p.description,
      since: p.firstSeen,
      status: problemStatus(
        p.onLatest,
        p.visitIds.size,
        p.lastSeen.getTime() - p.firstSeen.getTime()
      ),
    }))
    .sort((a, b) => b.since.getTime() - a.since.getTime());
};

// "Active" while the issuing prescription is open; "Completed" once fully
// served or cancelled.
const medicationStatus = (prescriptionStatus: string): string =>
  prescriptionStatus === "FULLY_SERVED" || prescriptionStatus === "CANCELLED"
    ? "Completed"
    : "Active";

const deriveMedications = (visits: ChartVisit[]) =>
  visits.flatMap((visit) =>
    visit.prescriptions.flatMap((rx) =>
      rx.items.map((item) => ({
        id: item.id,
        medicationName: item.medicationName,
        dosage: item.dosage,
        frequency: item.frequency,
        duration: item.duration,
        instructions: item.instructions,
        status: medicationStatus(rx.status),
        prescribedOn: rx.createdAt,
        prescriber: rx.doctor?.name ?? null,
      }))
    )
  );

/** Current meds = items on the newest prescription across visits. */
const deriveCurrentMedications = (visits: ChartVisit[]) => {
  const newestRx = visits
    .flatMap((v) => v.prescriptions)
    .filter((rx) => medicationStatus(rx.status) === "Active")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!newestRx) {
    return [];
  }
  return newestRx.items.map((item) => ({
    id: item.id,
    medicationName: item.medicationName,
    dosage: item.dosage,
    frequency: item.frequency,
    duration: item.duration,
    status: medicationStatus(newestRx.status),
  }));
};

const deriveEncounters = (visits: ChartVisit[]) =>
  visits.map((visit) => ({
    id: visit.id,
    type: encounterTypeOf(visit),
    diagnosis:
      visit.visitDiagnoses[0]?.description ??
      visit.diagnosis ??
      visit.chiefComplaint ??
      null,
    doctor: visit.doctor?.name ?? null,
    disposition: dispositionOf(visit.careStage, visit.status),
    date: visit.startTime,
  }));

const deriveVitals = (visits: ChartVisit[]) =>
  visits
    .filter((v) => v.triage)
    .map((v) => ({
      visitId: v.id,
      date: v.triage?.createdAt ?? v.startTime,
      bloodPressure: v.triage?.bloodPressure ?? null,
      heartRate: v.triage?.heartRate ?? null,
      temperature: v.triage?.temperature ?? null,
      respiratory: v.triage?.respiratory ?? null,
      spo2: v.triage?.spo2 ?? null,
      weight: v.triage?.weight ?? null,
      height: v.triage?.height ?? null,
      bmi: v.triage?.bmi ?? null,
      bloodSugar: v.triage?.bloodSugar ?? null,
    }));

const RANGE_RE = /(-?\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(-?\d+(?:\.\d+)?)/i;
// Qualitative results that read as "concerning" when they shouldn't be present.
const POSITIVE_TERMS = ["positive", "reactive", "detected", "abnormal"];

type LabFlag = "Normal" | "Low" | "High" | "Critical";

type ResultParameter = {
  name?: string;
  value?: string;
  unit?: string;
  referenceRange?: string;
};
type ParsedResults = {
  productName?: string;
  conclusion?: string;
  parameters: ResultParameter[];
};

/** Exam results are stored as JSON (sometimes a JSON string). Parse defensively. */
const parseResults = (raw: unknown): ParsedResults => {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { parameters: [] };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { parameters: [] };
  }

  const parsed = value as Omit<ParsedResults, "parameters"> & {
    parameters?: unknown;
  };

  return {
    ...parsed,
    parameters: Array.isArray(parsed.parameters) ? parsed.parameters : [],
  };
};

/** Flag a parameter's value against its reference range (numeric or qualitative). */
const flagFor = (
  value: string | undefined,
  reference: string | null | undefined,
  conclusion: string | undefined
): LabFlag | null => {
  const numValue = value != null ? Number.parseFloat(value) : Number.NaN;
  const rangeMatch = reference?.match(RANGE_RE);
  if (rangeMatch && !Number.isNaN(numValue)) {
    const min = Number.parseFloat(rangeMatch[1]);
    const max = Number.parseFloat(rangeMatch[2]);
    if (numValue < min) {
      return "Low";
    }
    if (numValue > max) {
      return "High";
    }
    return "Normal";
  }
  // Qualitative: compare against a non-numeric reference (e.g. "Negative").
  if (value && reference && Number.isNaN(Number.parseFloat(reference))) {
    const v = value.trim().toLowerCase();
    const r = reference.trim().toLowerCase();
    if (v === r) {
      return "Normal";
    }
    return POSITIVE_TERMS.includes(v) ? "Critical" : "High";
  }
  switch ((conclusion ?? "").toLowerCase()) {
    case "critical":
      return "Critical";
    case "abnormal":
    case "suspicious":
      return "High";
    case "normal":
      return "Normal";
    default:
      return null;
  }
};

// One row per measured parameter (Test · Result · Reference · Date · Flag).
const deriveLabResults = (visits: ChartVisit[]) =>
  visits.flatMap((visit) =>
    visit.examResults.flatMap((result) => {
      const parsed = parseResults(result.results);
      const date = result.examDate;
      const params = parsed.parameters ?? [];
      if (params.length === 0) {
        // No per-parameter breakdown — surface the exam's overall conclusion.
        const test =
          parsed.productName ??
          result.product?.name ??
          result.exam?.name ??
          "Result";
        return [
          {
            id: `${result.id}`,
            test,
            value: parsed.conclusion ?? "—",
            unit: result.product?.unit ?? null,
            reference: result.product?.normalRange ?? null,
            flag: flagFor(
              parsed.conclusion,
              result.product?.normalRange ?? null,
              parsed.conclusion
            ),
            date,
          },
        ];
      }
      return params.map((p, i) => {
        const reference =
          p.referenceRange ?? result.product?.normalRange ?? null;
        return {
          id: `${result.id}-${i}`,
          test: p.name ?? result.product?.name ?? "Result",
          value: p.value ?? "—",
          unit: p.unit ?? null,
          reference,
          flag: flagFor(p.value, reference, parsed.conclusion),
          date,
        };
      });
    })
  );

/** Distinct staff across the patient's visits, labeled by system role. */
const deriveCareTeam = (visits: ChartVisit[]) => {
  const byId = new Map<
    number,
    { id: number; name: string; role: string; lastSeen: Date }
  >();
  const add = (staff: StaffRef, when: Date) => {
    if (!staff) {
      return;
    }
    const existing = byId.get(staff.id);
    if (!existing || existing.lastSeen < when) {
      byId.set(staff.id, {
        id: staff.id,
        name: staff.name,
        role: staff.role,
        lastSeen: when,
      });
    }
  };
  for (const visit of visits) {
    add(visit.doctor, visit.startTime);
    add(visit.triage?.recordedBy, visit.startTime);
    for (const rx of visit.prescriptions) {
      add(rx.doctor, rx.createdAt);
    }
    for (const result of visit.examResults) {
      add(result.createdBy, result.examDate);
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())
    .map((s) => ({ id: s.id, name: s.name, roleLabel: careRoleLabel(s.role) }));
};

export const getPatientChart = async (c: Context<AppEnv>) => {
  try {
    const patientIdParam = c.req.param("id");
    if (!PATIENT_PARAM_TEST_REGEX.test(patientIdParam)) {
      return c.json({ error: "Invalid patient id" }, 400);
    }
    const patientId = Number(patientIdParam);
    if (!Number.isSafeInteger(patientId)) {
      return c.json({ error: "Invalid patient id" }, 400);
    }
    const clinicId = c.get("clinicId");
    const chartInclude = buildChartInclude(chartVisitWindowStart());

    const patient = await db.patient.findFirst({
      where: {
        id: patientId,
        clinics:
          typeof clinicId === "number" ? { some: { id: clinicId } } : undefined,
      },
      include: chartInclude,
    });

    if (!patient) {
      return c.json({ error: "Patient not found" }, 404);
    }

    const visits = patient.visits;
    const policy = patient.patientInsurance?.[0];

    return c.json({
      data: {
        header: {
          id: patient.id,
          patientId: patient.patientId,
          firstName: patient.firstName,
          lastName: patient.lastName,
          gender: patient.gender,
          dateOfBirth: patient.dateOfBirth,
          phoneNumber: patient.phoneNumber,
          bloodType: medicalInfoString(patient.medicalInfo, "bloodType"),
          insurer: policy?.insuranceCompany?.companyName ?? null,
          coveragePercentage:
            policy?.coveragePercentage != null
              ? Number(policy.coveragePercentage)
              : null,
          allergies: allergiesOf(patient.medicalInfo),
        },
        bpTrend: deriveBpTrend(visits),
        problemList: deriveProblemList(visits),
        currentMedications: deriveCurrentMedications(visits),
        encounters: deriveEncounters(visits),
        careTeam: deriveCareTeam(visits),
        vitals: deriveVitals(visits),
        labResults: deriveLabResults(visits),
        medications: deriveMedications(visits),
      },
    });
  } catch (_error) {
    return c.json({ error: "Internal Server Error" }, 500);
  }
};
