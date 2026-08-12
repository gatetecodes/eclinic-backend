import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "@/database/db";
import { isUniqueViolationOn } from "@/lib/app-error";
import { logger } from "@/lib/logger";
import { Prisma, type PrismaClient } from "../../../generated/prisma/client";
import {
  mapLabResultObservation,
  mapLabServiceRequest,
  mapMedicationAdministration,
  mapMedicationDispense,
  mapMedicationRequest,
  mapProcedure,
} from "./clinical-resource.mapper";
import { mapVisitCondition } from "./condition.mapper";
import { mapHieConsent } from "./consent.mapper";
import {
  mapConsultationEncounter,
  mapConsultationObservation,
} from "./consultation.mapper";
import {
  mapImagingServiceRequest,
  mapImagingStudy,
  mapStructuredAllergy,
  mapStructuredImmunization,
} from "./deferred-clinical.mapper";
import { mapDischargeIpsBundle } from "./discharge-ips.mapper";
import {
  mapTransferEncounter,
  mapTransferIpsBundle,
  mapVisitEncounter,
} from "./encounter.mapper";
import {
  decryptHieJson,
  decryptHieValue,
  encryptHieJson,
  encryptHieValue,
  hashHieIdentifier,
} from "./hie-crypto.service";
import {
  deterministicHieResourceId,
  hieOutboxIdempotencyKey,
} from "./hie-resource-id";
import { RhieRequestError, rhieRequest } from "./rhie-client";
import {
  mapVitalObservation,
  parseVitalValue,
  type VitalMetric,
  vitalMetricSchema,
} from "./vital-observation.mapper";

const MAX_ATTEMPTS = 8;
const FINALIZED_VISIT_RECOVERY_DELAY_MS = 5 * 60_000;
const PATIENT_IDENTITY_DEPENDENCY_REASON =
  "Verified Client Registry identity is required";
const ACTIVE_CONSENT_DEPENDENCY_REASON =
  "Active HIE sharing consent is required";
const RESUMABLE_PATIENT_DEPENDENCY_REASONS = [
  PATIENT_IDENTITY_DEPENDENCY_REASON,
  ACTIVE_CONSENT_DEPENDENCY_REASON,
] as const;
const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
  24 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

function withIdempotencyKeys(
  events: Prisma.HieOutboxEventCreateManyInput[],
  params: { environment: "TEST" | "PRODUCTION"; clinicId: number }
) {
  return events.map((event) => ({
    ...event,
    idempotencyKey:
      event.idempotencyKey ??
      hieOutboxIdempotencyKey({
        environment: params.environment,
        clinicId: params.clinicId,
        localResourceType: event.aggregateType,
        localResourceId: event.aggregateId,
        hieResourceType: event.resourceType,
        operation: event.operation,
      }),
  }));
}

const legacyVisitPayloadSchema = z.object({
  visitId: z.number().int().positive(),
});
const visitSnapshotPayloadSchema = legacyVisitPayloadSchema.extend({
  patientId: z.number().int().positive(),
  doctorId: z.number().int().positive().nullable(),
  branchId: z.number().int().positive().nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  resourceId: z.string().uuid().optional(),
});
const visitPayloadSchema = z.union([
  visitSnapshotPayloadSchema,
  legacyVisitPayloadSchema,
]);
const legacyConditionPayloadSchema = z.object({
  diagnosisId: z.number().int().positive(),
});
const conditionSnapshotPayloadSchema = legacyConditionPayloadSchema.extend({
  visitId: z.number().int().positive(),
  patientId: z.number().int().positive(),
  doctorId: z.number().int().positive().nullable(),
  icd11Code: z.string().trim().nullable(),
  description: z.string().trim().min(1),
  recordedAt: z.iso.datetime(),
});
const conditionPayloadSchema = z.union([
  conditionSnapshotPayloadSchema,
  legacyConditionPayloadSchema,
]);
const transferPayloadSchema = z.object({
  transferId: z.number().int().positive(),
});
const transferSnapshotPayloadSchema = transferPayloadSchema.extend({
  visitId: z.number().int().positive(),
  patientId: z.number().int().positive(),
  sourceBranchId: z.number().int().positive(),
  referringPractitionerId: z.number().int().positive(),
  destinationFacilityId: z.number().int().positive(),
  destinationLocationReference: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  clinicalSummary: z.string().trim().min(1),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  authoredAt: z.iso.datetime(),
});
const queuedTransferPayloadSchema = z.union([
  transferSnapshotPayloadSchema,
  transferPayloadSchema,
]);
const legacyVitalPayloadSchema = z.object({
  triageId: z.number().int().positive(),
  metric: vitalMetricSchema,
});
const vitalSnapshotPayloadSchema = legacyVitalPayloadSchema.extend({
  visitId: z.number().int().positive(),
  patientId: z.number().int().positive(),
  practitionerId: z.number().int().positive().nullable(),
  rawValue: z.string(),
  effectiveAt: z.iso.datetime(),
});
const vitalPayloadSchema = z.union([
  vitalSnapshotPayloadSchema,
  legacyVitalPayloadSchema,
]);
const clinicalSnapshotPayloadSchema = z.object({
  kind: z.enum([
    "LAB_REQUEST",
    "LAB_RESULT",
    "MEDICATION_REQUEST",
    "MEDICATION_DISPENSE",
    "MEDICATION_ADMINISTRATION",
    "PROCEDURE",
    "WARD_OBSERVATION",
  ]),
  localResourceType: z.string().min(1),
  localResourceId: z.string().min(1),
  visitId: z.number().int().positive(),
  patientId: z.number().int().positive(),
  practitionerId: z.number().int().positive().nullable(),
  branchId: z.number().int().positive().nullable(),
  code: z.string().trim().nullable(),
  terminologyStatus: z.enum(["DRAFT", "VERIFIED"]).nullable(),
  display: z.string().trim().min(1),
  clinicalAt: z.iso.datetime(),
  value: z.string().optional(),
  unit: z.string().optional(),
  dosage: z.string().optional(),
  route: z.string().optional(),
  frequency: z.string().optional(),
  duration: z.string().optional(),
  doseValue: z.number().positive().optional(),
  doseUnit: z.string().min(1).optional(),
  frequencyCount: z.number().int().positive().optional(),
  frequencyPeriod: z.number().positive().optional(),
  frequencyPeriodUnit: z
    .enum(["s", "min", "h", "d", "wk", "mo", "a"])
    .optional(),
  routeSystem: z.string().min(1).optional(),
  routeCode: z.string().min(1).optional(),
  routeDisplay: z.string().min(1).optional(),
  methodSystem: z.string().min(1).optional(),
  methodCode: z.string().min(1).optional(),
  methodDisplay: z.string().min(1).optional(),
  durationValue: z.number().positive().optional(),
  durationUnit: z.enum(["s", "min", "h", "d", "wk", "mo", "a"]).optional(),
  groupIdentifier: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  quantity: z.number().positive().optional(),
  relatedLocalResourceType: z.string().optional(),
  relatedLocalResourceId: z.string().optional(),
  metric: vitalMetricSchema.optional(),
});
const dischargeIpsPayloadSchema = z.object({
  hospitalizationId: z.number().int().positive(),
  visitId: z.number().int().positive(),
  patientId: z.number().int().positive(),
  practitionerId: z.number().int().positive(),
  branchId: z.number().int().positive(),
  authoredAt: z.iso.datetime(),
  finalDiagnosis: z.string().nullable(),
  clinicalSummary: z.string().nullable(),
  patientInstructions: z.string().nullable(),
  followUpAt: z.iso.datetime().nullable(),
  destination: z.string().min(1),
});
const consentPayloadSchema = z.object({
  consentId: z.number().int().positive(),
  patientId: z.number().int().positive(),
  scope: z.enum(["patient-privacy", "treatment", "research"]),
  purpose: z.string().trim().min(1),
  recordedAt: z.iso.datetime(),
  hieResourceIdEncrypted: z.string().optional(),
});
const deferredClinicalPayloadSchema = z.object({
  localId: z.number().int().positive(),
  hieResourceIdEncrypted: z.string().optional(),
});
const allergyReactionSchema = z.object({
  manifestationCode: z.string().min(1),
  manifestationDisplay: z.string().min(1),
  severity: z.string().optional(),
});
const medicationPeriodUnitSchema = z.enum([
  "s",
  "min",
  "h",
  "d",
  "wk",
  "mo",
  "a",
]);
type StructuredMedicationSource = {
  doseValue: Prisma.Decimal | null;
  doseUnit: string | null;
  frequencyCount: number | null;
  frequencyPeriod: Prisma.Decimal | null;
  frequencyPeriodUnit: string | null;
  routeSystem: string | null;
  routeCode: string | null;
  routeDisplay: string | null;
  methodSystem: string | null;
  methodCode: string | null;
  methodDisplay: string | null;
  durationValue: Prisma.Decimal | null;
  durationUnit: string | null;
};

function structuredMedicationSnapshot(value: StructuredMedicationSource) {
  return {
    doseValue: value.doseValue ? Number(value.doseValue) : undefined,
    doseUnit: value.doseUnit ?? undefined,
    frequencyCount: value.frequencyCount ?? undefined,
    frequencyPeriod: value.frequencyPeriod
      ? Number(value.frequencyPeriod)
      : undefined,
    frequencyPeriodUnit: medicationPeriodUnitSchema.safeParse(
      value.frequencyPeriodUnit
    ).data,
    routeSystem: value.routeSystem ?? undefined,
    routeCode: value.routeCode ?? undefined,
    routeDisplay: value.routeDisplay ?? undefined,
    methodSystem: value.methodSystem ?? undefined,
    methodCode: value.methodCode ?? undefined,
    methodDisplay: value.methodDisplay ?? undefined,
    durationValue: value.durationValue
      ? Number(value.durationValue)
      : undefined,
    durationUnit: medicationPeriodUnitSchema.safeParse(value.durationUnit).data,
  };
}

function optionalStructuredMedicationSnapshot(
  value: StructuredMedicationSource | null
) {
  return value ? structuredMedicationSnapshot(value) : {};
}

type SnomedProductRef = {
  name: string;
  snomedCode: string | null;
  terminologyStatus: "DRAFT" | "VERIFIED";
};

function snomedProductCoding(
  product: SnomedProductRef | null | undefined,
  fallbackDisplay: string
) {
  return {
    code: product?.snomedCode ?? null,
    terminologyStatus: product?.terminologyStatus ?? null,
    display: product?.name ?? fallbackDisplay,
  };
}

function relatedPrescriptionItemRef(prescriptionItemId: number | null) {
  return prescriptionItemId
    ? {
        relatedLocalResourceType: "PrescriptionItem",
        relatedLocalResourceId: String(prescriptionItemId),
      }
    : {};
}
const examResultValueSchema = z.object({
  parameters: z
    .array(
      z.object({
        name: z.string().optional(),
        value: z.string().optional(),
        unit: z.string().optional(),
      })
    )
    .optional(),
  conclusion: z.string().optional(),
});

function clinicalDependencyReason(params: {
  inherited: string | null;
  code: string | null;
  terminologyStatus: "DRAFT" | "VERIFIED" | null;
  codeName: string;
}) {
  if (!params.code) {
    return `${params.codeName} code is required for HIE publication`;
  }
  if (params.terminologyStatus !== "VERIFIED") {
    return "A platform-verified terminology mapping is required";
  }
  return params.inherited;
}

function patientPublicationDependencyReason(
  hasIdentity: boolean,
  hasConsent: boolean
) {
  if (!hasIdentity) {
    return PATIENT_IDENTITY_DEPENDENCY_REASON;
  }
  if (!hasConsent) {
    return ACTIVE_CONSENT_DEPENDENCY_REASON;
  }
  return null;
}

function parseFinalLabResult(rawResult: unknown) {
  const parsed = examResultValueSchema.safeParse(rawResult);
  if (!parsed.success) {
    return { parameter: undefined, value: undefined };
  }
  const parameter = parsed.data.parameters?.find((item) => item.value?.trim());
  return {
    parameter,
    value: parameter?.value ?? parsed.data.conclusion,
  };
}

function labResultDependencyReason(params: {
  value: string | undefined;
  code: string | null;
  status: "DRAFT" | "VERIFIED" | null;
  inherited: string | null;
}) {
  if (!params.value) {
    return "A finalized lab value or conclusion is required";
  }
  return clinicalDependencyReason({
    inherited: params.inherited,
    code: params.code,
    terminologyStatus: params.status,
    codeName: "LOINC",
  });
}

function structuredMedicationDependencyReason(params: {
  inherited: string | null;
  snapshot: z.infer<typeof clinicalSnapshotPayloadSchema>;
  requireMethod?: boolean;
}) {
  const value = params.snapshot;
  const required = [
    value.doseValue,
    value.doseUnit,
    value.frequencyCount,
    value.frequencyPeriod,
    value.frequencyPeriodUnit,
    value.routeSystem,
    value.routeCode,
    value.routeDisplay,
    value.durationValue,
    value.durationUnit,
  ];
  if (required.some((field) => field === undefined || field === null)) {
    return "Structured dose, frequency, route, and duration are required";
  }
  if (
    params.requireMethod &&
    !(value.methodSystem && value.methodCode && value.methodDisplay)
  ) {
    return "A structured administration method is required";
  }
  return params.inherited;
}

async function buildExtendedClinicalEvents(
  tx: Prisma.TransactionClient,
  params: {
    clinicId: number;
    visitId: number;
    patientId: number;
    doctorId: number | null;
    branchId: number | null;
  },
  dependencyReason: string | null
) {
  const [
    exams,
    results,
    prescriptions,
    dispenses,
    treatments,
    hospitalization,
  ] = await Promise.all([
    tx.exam.findMany({
      where: { visitId: params.visitId },
      select: {
        id: true,
        createdAt: true,
        products: {
          select: {
            id: true,
            name: true,
            snomedCode: true,
            terminologyStatus: true,
          },
        },
      },
    }),
    tx.examResult.findMany({
      where: { visitId: params.visitId, status: "COMPLETED" },
      select: {
        id: true,
        examId: true,
        examDate: true,
        results: true,
        createdById: true,
        product: {
          select: {
            id: true,
            name: true,
            loincCode: true,
            terminologyStatus: true,
            unit: true,
          },
        },
        exam: {
          select: {
            products: {
              select: {
                id: true,
                name: true,
                loincCode: true,
                terminologyStatus: true,
                unit: true,
              },
            },
          },
        },
      },
    }),
    tx.prescription.findMany({
      where: {
        visitId: params.visitId,
        status: { in: ["ISSUED", "PARTIALLY_SERVED", "FULLY_SERVED"] },
      },
      select: {
        id: true,
        doctorId: true,
        createdAt: true,
        items: {
          select: {
            id: true,
            medicationName: true,
            dosage: true,
            frequency: true,
            createdAt: true,
            duration: true,
            doseValue: true,
            doseUnit: true,
            frequencyCount: true,
            frequencyPeriod: true,
            frequencyPeriodUnit: true,
            routeSystem: true,
            routeCode: true,
            routeDisplay: true,
            methodSystem: true,
            methodCode: true,
            methodDisplay: true,
            durationValue: true,
            durationUnit: true,
            pharmacyItemMap: {
              select: {
                inventoryItem: {
                  select: {
                    product: {
                      select: {
                        name: true,
                        snomedCode: true,
                        terminologyStatus: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
    tx.pharmacyDispenseOrder.findMany({
      where: { visitId: params.visitId },
      select: {
        id: true,
        performedByUserId: true,
        branchId: true,
        createdAt: true,
        lines: {
          select: {
            id: true,
            quantity: true,
            prescriptionItemId: true,
            prescriptionItem: {
              select: {
                dosage: true,
                frequency: true,
                duration: true,
                doseValue: true,
                doseUnit: true,
                frequencyCount: true,
                frequencyPeriod: true,
                frequencyPeriodUnit: true,
                routeSystem: true,
                routeCode: true,
                routeDisplay: true,
                methodSystem: true,
                methodCode: true,
                methodDisplay: true,
                durationValue: true,
                durationUnit: true,
              },
            },
            inventoryItem: {
              select: {
                unit: true,
                product: {
                  select: {
                    name: true,
                    snomedCode: true,
                    terminologyStatus: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
    tx.treatment.findMany({
      where: { visitId: params.visitId },
      select: {
        id: true,
        createdAt: true,
        products: {
          select: {
            id: true,
            name: true,
            ichiCode: true,
            terminologyStatus: true,
          },
        },
      },
    }),
    tx.hospitalization.findUnique({
      where: { visitId: params.visitId },
      select: {
        branchId: true,
        attendingId: true,
        observations: {
          select: {
            id: true,
            recordedById: true,
            recordedAt: true,
            temperature: true,
            heartRate: true,
            respiratoryRate: true,
            spo2: true,
          },
        },
        medications: {
          select: {
            id: true,
            createdAt: true,
            drugName: true,
            dose: true,
            route: true,
            frequency: true,
            doseValue: true,
            doseUnit: true,
            frequencyCount: true,
            frequencyPeriod: true,
            frequencyPeriodUnit: true,
            routeSystem: true,
            routeCode: true,
            routeDisplay: true,
            methodSystem: true,
            methodCode: true,
            methodDisplay: true,
            durationValue: true,
            durationUnit: true,
            prescribedById: true,
            product: {
              select: {
                name: true,
                snomedCode: true,
                terminologyStatus: true,
              },
            },
            administrations: {
              where: { status: "GIVEN", administeredAt: { not: null } },
              select: {
                id: true,
                administeredAt: true,
                administeredById: true,
              },
            },
          },
        },
      },
    }),
  ]);

  const events: Prisma.HieOutboxEventCreateManyInput[] = [];
  const push = (
    snapshot: z.infer<typeof clinicalSnapshotPayloadSchema>,
    order: number,
    reason: string | null
  ) => {
    events.push({
      clinicId: params.clinicId,
      aggregateType: snapshot.localResourceType,
      aggregateId: snapshot.localResourceId,
      resourceType: snapshot.kind,
      operation: "CREATE",
      dependencyOrder: order,
      payloadEncrypted: encryptHieJson(snapshot),
      status: reason ? "BLOCKED" : "PENDING",
      dependencyReason: reason,
      correlationId: randomUUID(),
    });
  };

  const appendLabRequests = () => {
    for (const exam of exams) {
      for (const product of exam.products) {
        push(
          {
            kind: "LAB_REQUEST",
            localResourceType: "Exam",
            localResourceId: `${exam.id}:${product.id}`,
            visitId: params.visitId,
            patientId: params.patientId,
            practitionerId: params.doctorId,
            branchId: params.branchId,
            code: product.snomedCode,
            terminologyStatus: product.terminologyStatus,
            display: product.name,
            clinicalAt: exam.createdAt.toISOString(),
          },
          20,
          clinicalDependencyReason({
            inherited: dependencyReason,
            code: product.snomedCode,
            terminologyStatus: product.terminologyStatus,
            codeName: "SNOMED CT",
          })
        );
      }
    }
  };
  appendLabRequests();

  const appendLabResults = () => {
    for (const result of results) {
      const product = result.product ?? result.exam.products[0];
      const { parameter, value } = parseFinalLabResult(result.results);
      const reason = labResultDependencyReason({
        value,
        code: product?.loincCode ?? null,
        status: product?.terminologyStatus ?? null,
        inherited: dependencyReason,
      });
      push(
        {
          kind: "LAB_RESULT",
          localResourceType: "ExamResult",
          localResourceId: String(result.id),
          visitId: params.visitId,
          patientId: params.patientId,
          practitionerId: result.createdById ?? params.doctorId,
          branchId: params.branchId,
          code: product?.loincCode ?? null,
          terminologyStatus: product?.terminologyStatus ?? null,
          display: parameter?.name ?? product?.name ?? "Laboratory result",
          clinicalAt: result.examDate.toISOString(),
          value: value ?? "",
          unit: parameter?.unit ?? product?.unit ?? undefined,
          relatedLocalResourceType: "Exam",
          relatedLocalResourceId: product
            ? `${result.examId}:${product.id}`
            : undefined,
        },
        30,
        reason
      );
    }
  };
  appendLabResults();

  const appendMedicationRequests = () => {
    for (const prescription of prescriptions) {
      for (const item of prescription.items) {
        const product = item.pharmacyItemMap?.inventoryItem.product;
        const snapshot = {
          kind: "MEDICATION_REQUEST" as const,
          localResourceType: "PrescriptionItem",
          localResourceId: String(item.id),
          visitId: params.visitId,
          patientId: params.patientId,
          practitionerId: prescription.doctorId,
          branchId: params.branchId,
          code: product?.snomedCode ?? null,
          terminologyStatus: product?.terminologyStatus ?? null,
          display: product?.name ?? item.medicationName,
          clinicalAt: prescription.createdAt.toISOString(),
          dosage: item.dosage,
          frequency: item.frequency,
          duration: item.duration,
          groupIdentifier: String(prescription.id),
          ...structuredMedicationSnapshot(item),
        };
        const terminologyReason = clinicalDependencyReason({
          inherited: dependencyReason,
          code: product?.snomedCode ?? null,
          terminologyStatus: product?.terminologyStatus ?? null,
          codeName: "SNOMED CT medication",
        });
        push(
          snapshot,
          20,
          structuredMedicationDependencyReason({
            inherited: terminologyReason,
            snapshot,
          })
        );
      }
    }
  };
  appendMedicationRequests();

  const appendMedicationDispenses = () => {
    for (const dispense of dispenses) {
      for (const line of dispense.lines) {
        const coding = snomedProductCoding(
          line.inventoryItem.product,
          "Dispensed medication"
        );
        const snapshot = {
          kind: "MEDICATION_DISPENSE" as const,
          localResourceType: "PharmacyDispenseLine",
          localResourceId: String(line.id),
          visitId: params.visitId,
          patientId: params.patientId,
          practitionerId: dispense.performedByUserId,
          branchId: dispense.branchId ?? params.branchId,
          ...coding,
          clinicalAt: dispense.createdAt.toISOString(),
          quantity: line.quantity,
          unit: line.inventoryItem.unit ?? "unit",
          dosage: line.prescriptionItem?.dosage,
          frequency: line.prescriptionItem?.frequency,
          duration: line.prescriptionItem?.duration,
          ...optionalStructuredMedicationSnapshot(line.prescriptionItem),
          ...relatedPrescriptionItemRef(line.prescriptionItemId),
        };
        push(
          snapshot,
          30,
          structuredMedicationDependencyReason({
            inherited: clinicalDependencyReason({
              inherited: dependencyReason,
              code: coding.code,
              terminologyStatus: coding.terminologyStatus,
              codeName: "SNOMED CT medication",
            }),
            snapshot,
          })
        );
      }
    }
  };
  appendMedicationDispenses();

  const appendProcedures = () => {
    for (const treatment of treatments) {
      for (const product of treatment.products) {
        push(
          {
            kind: "PROCEDURE",
            localResourceType: "Treatment",
            localResourceId: `${treatment.id}:${product.id}`,
            visitId: params.visitId,
            patientId: params.patientId,
            practitionerId: params.doctorId,
            branchId: params.branchId,
            code: product.ichiCode,
            terminologyStatus: product.terminologyStatus,
            display: product.name,
            clinicalAt: treatment.createdAt.toISOString(),
          },
          20,
          clinicalDependencyReason({
            inherited: dependencyReason,
            code: product.ichiCode,
            terminologyStatus: product.terminologyStatus,
            codeName: "ICHI",
          })
        );
      }
    }
  };
  appendProcedures();

  const appendWardMedications = () => {
    for (const medication of hospitalization?.medications ?? []) {
      const product = medication.product;
      const requestSnapshot = {
        kind: "MEDICATION_REQUEST" as const,
        localResourceType: "WardMedication",
        localResourceId: String(medication.id),
        visitId: params.visitId,
        patientId: params.patientId,
        practitionerId:
          medication.prescribedById ??
          hospitalization?.attendingId ??
          params.doctorId,
        branchId: hospitalization?.branchId ?? params.branchId,
        code: product?.snomedCode ?? null,
        terminologyStatus: product?.terminologyStatus ?? null,
        display: product?.name ?? medication.drugName,
        clinicalAt: medication.createdAt.toISOString(),
        dosage: medication.dose,
        route: medication.route,
        frequency: medication.frequency,
        groupIdentifier: `WARD-${medication.id}`,
        ...structuredMedicationSnapshot(medication),
      };
      const requestTerminologyReason = clinicalDependencyReason({
        inherited: dependencyReason,
        code: product?.snomedCode ?? null,
        terminologyStatus: product?.terminologyStatus ?? null,
        codeName: "SNOMED CT medication",
      });
      push(
        requestSnapshot,
        20,
        structuredMedicationDependencyReason({
          inherited: requestTerminologyReason,
          snapshot: requestSnapshot,
        })
      );
      const appendAdministration = (
        administration: (typeof medication.administrations)[number]
      ) => {
        if (!administration.administeredAt) {
          return;
        }
        const administrationSnapshot = {
          kind: "MEDICATION_ADMINISTRATION" as const,
          localResourceType: "WardMedicationAdministration",
          localResourceId: String(administration.id),
          visitId: params.visitId,
          patientId: params.patientId,
          practitionerId:
            administration.administeredById ?? medication.prescribedById,
          branchId: hospitalization?.branchId ?? params.branchId,
          code: product?.snomedCode ?? null,
          terminologyStatus: product?.terminologyStatus ?? null,
          display: product?.name ?? medication.drugName,
          clinicalAt: administration.administeredAt.toISOString(),
          dosage: medication.dose,
          route: medication.route,
          frequency: medication.frequency,
          reason: "Medication administered as prescribed",
          ...structuredMedicationSnapshot(medication),
          relatedLocalResourceType: "WardMedication",
          relatedLocalResourceId: String(medication.id),
        };
        const administrationTerminologyReason = clinicalDependencyReason({
          inherited: dependencyReason,
          code: product?.snomedCode ?? null,
          terminologyStatus: product?.terminologyStatus ?? null,
          codeName: "SNOMED CT medication",
        });
        push(
          administrationSnapshot,
          30,
          structuredMedicationDependencyReason({
            inherited: administrationTerminologyReason,
            snapshot: administrationSnapshot,
            requireMethod: true,
          })
        );
      };
      for (const administration of medication.administrations) {
        appendAdministration(administration);
      }
    }
  };
  appendWardMedications();

  const appendWardObservations = () => {
    for (const observation of hospitalization?.observations ?? []) {
      const metrics = [
        ["temperature", observation.temperature],
        ["heartRate", observation.heartRate],
        ["respiratory", observation.respiratoryRate],
        ["spo2", observation.spo2],
      ] as const satisfies ReadonlyArray<readonly [VitalMetric, string | null]>;
      const appendMetric = ([metric, rawValue]: (typeof metrics)[number]) => {
        if (!rawValue) {
          return;
        }
        const reason =
          parseVitalValue(rawValue) === null
            ? `A numeric UCUM-compatible value is required for ${metric}`
            : dependencyReason;
        push(
          {
            kind: "WARD_OBSERVATION",
            localResourceType: "WardObservation",
            localResourceId: `${observation.id}:${metric}`,
            visitId: params.visitId,
            patientId: params.patientId,
            practitionerId:
              observation.recordedById ??
              hospitalization?.attendingId ??
              params.doctorId,
            branchId: hospitalization?.branchId ?? params.branchId,
            code: null,
            terminologyStatus: null,
            display: metric,
            clinicalAt: observation.recordedAt.toISOString(),
            value: rawValue,
            metric,
          },
          20,
          reason
        );
      };
      for (const metric of metrics) {
        appendMetric(metric);
      }
    }
  };
  appendWardObservations();
  return events;
}

const VITAL_METRICS = [
  "height",
  "weight",
  "temperature",
  "heartRate",
  "respiratory",
  "spo2",
  "bmi",
  "bloodSugar",
] as const satisfies readonly VitalMetric[];

export class HieDependencyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HieDependencyError";
    this.code = code;
  }
}

async function buildConditionEvents(
  tx: Prisma.TransactionClient,
  params: {
    clinicId: number;
    visitId: number;
    patientId: number;
    doctorId: number | null;
  },
  dependencyReason: string | null
) {
  const diagnoses = await tx.visitDiagnosis.findMany({
    where: { visitId: params.visitId },
    select: {
      id: true,
      icd11Code: true,
      description: true,
      createdAt: true,
    },
  });
  return diagnoses.map((diagnosis) => {
    const reason = diagnosis.icd11Code
      ? dependencyReason
      : "ICD-11 code is required for Condition publication";
    return {
      clinicId: params.clinicId,
      aggregateType: "VisitDiagnosis",
      aggregateId: String(diagnosis.id),
      resourceType: "Condition",
      operation: "CREATE",
      dependencyOrder: 10,
      payloadEncrypted: encryptHieJson({
        diagnosisId: diagnosis.id,
        visitId: params.visitId,
        patientId: params.patientId,
        doctorId: params.doctorId,
        icd11Code: diagnosis.icd11Code,
        description: diagnosis.description,
        recordedAt: diagnosis.createdAt.toISOString(),
      }),
      status: reason ? ("BLOCKED" as const) : ("PENDING" as const),
      dependencyReason: reason,
      correlationId: randomUUID(),
    };
  });
}

async function buildVitalEvents(
  tx: Prisma.TransactionClient,
  params: {
    clinicId: number;
    visitId: number;
    patientId: number;
    doctorId: number | null;
  },
  dependencyReason: string | null
) {
  const triage = await tx.triage.findUnique({
    where: { visitId: params.visitId },
    select: {
      id: true,
      recordedById: true,
      createdAt: true,
      height: true,
      weight: true,
      temperature: true,
      heartRate: true,
      respiratory: true,
      spo2: true,
      bmi: true,
      bloodSugar: true,
    },
  });
  if (!triage) {
    return [];
  }
  return VITAL_METRICS.flatMap((metric) => {
    const raw = triage[metric];
    if (!raw) {
      return [];
    }
    const reason =
      parseVitalValue(raw) !== null
        ? dependencyReason
        : `A numeric UCUM-compatible value is required for ${metric}`;
    return [
      {
        clinicId: params.clinicId,
        aggregateType: "Triage",
        aggregateId: `${triage.id}:${metric}`,
        resourceType: "Observation",
        operation: "CREATE",
        dependencyOrder: 10,
        payloadEncrypted: encryptHieJson({
          triageId: triage.id,
          visitId: params.visitId,
          patientId: params.patientId,
          practitionerId: triage.recordedById ?? params.doctorId,
          metric,
          rawValue: raw,
          effectiveAt: triage.createdAt.toISOString(),
        }),
        status: reason ? ("BLOCKED" as const) : ("PENDING" as const),
        dependencyReason: reason,
        correlationId: randomUUID(),
      },
    ];
  });
}

/**
 * Identifies the one Encounter event a finalized visit may have. Shared by the
 * fast path below and the duplicate-race recovery in `enqueueFinalizedVisit`, so
 * the two can never look for different rows.
 */
function finalizedVisitEncounterWhere(params: {
  clinicId: number;
  visitId: number;
}): Prisma.HieOutboxEventWhereInput {
  return {
    clinicId: params.clinicId,
    aggregateType: "Visit",
    aggregateId: String(params.visitId),
    resourceType: "Encounter",
    operation: "CREATE",
  };
}

export async function enqueueFinalizedVisitInTransaction(
  tx: Prisma.TransactionClient,
  params: { clinicId: number; visitId: number; patientId: number }
) {
  const [config, visit] = await Promise.all([
    tx.hieTenantConfig.findUnique({
      where: { clinicId: params.clinicId },
      select: {
        enabled: true,
        sharedRecordWriteEnabled: true,
        consultationWriteEnabled: true,
        environment: true,
      },
    }),
    tx.visit.findFirst({
      where: {
        id: params.visitId,
        clinicId: params.clinicId,
        patientId: params.patientId,
        status: "FINALIZED",
      },
      select: {
        id: true,
        patientId: true,
        doctorId: true,
        branchId: true,
        startTime: true,
        endTime: true,
        updatedAt: true,
      },
    }),
  ]);
  if (!(config?.enabled && config.sharedRecordWriteEnabled)) {
    return null;
  }
  if (!visit) {
    throw new HieDependencyError(
      "FINALIZED_VISIT_REQUIRED",
      "A finalized visit is required for HIE publication"
    );
  }
  const existingEncounter = await tx.hieOutboxEvent.findFirst({
    where: finalizedVisitEncounterWhere(params),
  });
  if (existingEncounter) {
    return existingEncounter;
  }
  const now = new Date();
  const [identity, consent] = await Promise.all([
    tx.patientExternalIdentity.findFirst({
      where: {
        patientId: params.patientId,
        verificationStatus: "VERIFIED",
        resourceIdEncrypted: { not: null },
      },
      select: { id: true },
    }),
    tx.hieConsent.findFirst({
      where: {
        clinicId: params.clinicId,
        patientId: params.patientId,
        status: "ACTIVE",
        syncStatus: "SYNCED",
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      select: { id: true },
    }),
  ]);
  let dependencyReason: string | null = null;
  if (!identity) {
    dependencyReason = PATIENT_IDENTITY_DEPENDENCY_REASON;
  } else if (!consent) {
    dependencyReason = ACTIVE_CONSENT_DEPENDENCY_REASON;
  }
  const encounterEvent = await tx.hieOutboxEvent.create({
    data: {
      clinicId: params.clinicId,
      aggregateType: "Visit",
      aggregateId: String(params.visitId),
      resourceType: "Encounter",
      operation: "CREATE",
      payloadEncrypted: encryptHieJson({
        visitId: visit.id,
        patientId: visit.patientId,
        doctorId: visit.doctorId,
        branchId: visit.branchId,
        startedAt: visit.startTime.toISOString(),
        endedAt: (visit.endTime ?? visit.updatedAt).toISOString(),
      }),
      status: dependencyReason ? "BLOCKED" : "PENDING",
      dependencyReason,
      dependencyOrder: 10,
      idempotencyKey: hieOutboxIdempotencyKey({
        environment: config.environment,
        clinicId: params.clinicId,
        localResourceType: "Visit",
        localResourceId: String(params.visitId),
        hieResourceType: "Encounter",
        operation: "CREATE",
      }),
      correlationId: randomUUID(),
    },
  });
  if (config.consultationWriteEnabled && visit.doctorId && visit.branchId) {
    await tx.hieOutboxEvent.upsert({
      where: {
        idempotencyKey: hieOutboxIdempotencyKey({
          environment: config.environment,
          clinicId: params.clinicId,
          localResourceType: "VisitConsultation",
          localResourceId: String(params.visitId),
          hieResourceType: "Encounter",
          operation: "CREATE",
        }),
      },
      create: {
        clinicId: params.clinicId,
        aggregateType: "VisitConsultation",
        aggregateId: String(params.visitId),
        resourceType: "ConsultationEncounter",
        operation: "CREATE",
        dependencyOrder: 20,
        payloadEncrypted: encryptHieJson({ visitId: params.visitId }),
        status: dependencyReason ? "BLOCKED" : "PENDING",
        dependencyReason,
        idempotencyKey: hieOutboxIdempotencyKey({
          environment: config.environment,
          clinicId: params.clinicId,
          localResourceType: "VisitConsultation",
          localResourceId: String(params.visitId),
          hieResourceType: "Encounter",
          operation: "CREATE",
        }),
        correlationId: randomUUID(),
      },
      update: {},
    });
  }
  const [conditionEvents, observationEvents, clinicalEvents] =
    await Promise.all([
      buildConditionEvents(
        tx,
        { ...params, doctorId: visit.doctorId },
        dependencyReason
      ),
      buildVitalEvents(
        tx,
        { ...params, doctorId: visit.doctorId },
        dependencyReason
      ),
      buildExtendedClinicalEvents(
        tx,
        {
          ...params,
          doctorId: visit.doctorId,
          branchId: visit.branchId,
        },
        dependencyReason
      ),
    ]);
  if (conditionEvents.length > 0) {
    await tx.hieOutboxEvent.createMany({
      data: withIdempotencyKeys(conditionEvents, {
        environment: config.environment,
        clinicId: params.clinicId,
      }),
      skipDuplicates: true,
    });
  }
  if (observationEvents.length > 0) {
    await tx.hieOutboxEvent.createMany({
      data: withIdempotencyKeys(observationEvents, {
        environment: config.environment,
        clinicId: params.clinicId,
      }),
      skipDuplicates: true,
    });
  }
  if (clinicalEvents.length > 0) {
    await tx.hieOutboxEvent.createMany({
      data: withIdempotencyKeys(clinicalEvents, {
        environment: config.environment,
        clinicId: params.clinicId,
      }),
      skipDuplicates: true,
    });
  }
  return encounterEvent;
}

export async function enqueueFinalizedVisit(
  client: PrismaClient,
  params: { clinicId: number; visitId: number; patientId: number }
) {
  try {
    return await client.$transaction((tx) =>
      enqueueFinalizedVisitInTransaction(tx, params)
    );
  } catch (error) {
    if (!isUniqueViolationOn(error, ["idempotencyKey"])) {
      throw error;
    }
    // A concurrent enqueue created the event between our findFirst and our
    // insert. Enqueueing is idempotent, so the winner's event is this call's
    // result rather than an error. The re-read has to happen out here: a unique
    // violation aborts the surrounding Postgres transaction, so nothing can be
    // queried from inside it after the insert fails.
    return await client.hieOutboxEvent.findFirst({
      where: finalizedVisitEncounterWhere(params),
    });
  }
}

export async function enqueueCurrentClinicalEventsInTransaction(
  tx: Prisma.TransactionClient,
  params: { clinicId: number; visitId: number; patientId: number }
) {
  const [config, visit] = await Promise.all([
    tx.hieTenantConfig.findUnique({
      where: { clinicId: params.clinicId },
      select: {
        enabled: true,
        sharedRecordWriteEnabled: true,
        environment: true,
      },
    }),
    tx.visit.findFirst({
      where: {
        id: params.visitId,
        clinicId: params.clinicId,
        patientId: params.patientId,
      },
      select: { doctorId: true, branchId: true },
    }),
  ]);
  if (!(config?.enabled && config.sharedRecordWriteEnabled && visit)) {
    return 0;
  }
  const now = new Date();
  const [identity, consent] = await Promise.all([
    tx.patientExternalIdentity.findFirst({
      where: {
        patientId: params.patientId,
        verificationStatus: "VERIFIED",
        resourceIdEncrypted: { not: null },
      },
      select: { id: true },
    }),
    tx.hieConsent.findFirst({
      where: {
        clinicId: params.clinicId,
        patientId: params.patientId,
        status: "ACTIVE",
        syncStatus: "SYNCED",
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      select: { id: true },
    }),
  ]);
  const dependencyReason = patientPublicationDependencyReason(
    Boolean(identity),
    Boolean(consent)
  );
  const events = await buildExtendedClinicalEvents(
    tx,
    {
      ...params,
      doctorId: visit.doctorId,
      branchId: visit.branchId,
    },
    dependencyReason
  );
  if (events.length === 0) {
    return 0;
  }
  const existing = await tx.hieOutboxEvent.findMany({
    where: {
      clinicId: params.clinicId,
      OR: events.map((event) => ({
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        resourceType: event.resourceType,
      })),
    },
    select: { aggregateType: true, aggregateId: true, resourceType: true },
  });
  const existingKeys = new Set(
    existing.map(
      (event) =>
        `${event.aggregateType}:${event.aggregateId}:${event.resourceType}`
    )
  );
  const pending = events.filter(
    (event) =>
      !existingKeys.has(
        `${event.aggregateType}:${event.aggregateId}:${event.resourceType}`
      )
  );
  if (pending.length > 0) {
    await tx.hieOutboxEvent.createMany({
      data: withIdempotencyKeys(pending, {
        environment: config.environment,
        clinicId: params.clinicId,
      }),
      skipDuplicates: true,
    });
  }
  return pending.length;
}

export async function enqueueDischargeInTransaction(
  tx: Prisma.TransactionClient,
  params: {
    clinicId: number;
    hospitalizationId: number;
    visitId: number;
    patientId: number;
  }
) {
  const [config, visit, discharge, existingLink, existingEncounterEvent] =
    await Promise.all([
      tx.hieTenantConfig.findUnique({
        where: { clinicId: params.clinicId },
        select: {
          enabled: true,
          sharedRecordWriteEnabled: true,
          environment: true,
        },
      }),
      tx.visit.findFirst({
        where: {
          id: params.visitId,
          clinicId: params.clinicId,
          patientId: params.patientId,
          status: "DISCHARGED",
        },
        select: {
          id: true,
          patientId: true,
          doctorId: true,
          branchId: true,
          startTime: true,
          endTime: true,
          updatedAt: true,
        },
      }),
      tx.dischargeSummary.findUnique({
        where: { hospitalizationId: params.hospitalizationId },
        select: {
          finalDiagnosis: true,
          summary: true,
          patientInstructions: true,
          followUpDate: true,
          destination: true,
          dischargedById: true,
          createdAt: true,
        },
      }),
      tx.hieResourceLink.findUnique({
        where: {
          clinicId_localResourceType_localResourceId_hieResourceType: {
            clinicId: params.clinicId,
            localResourceType: "Visit",
            localResourceId: String(params.visitId),
            hieResourceType: "Encounter",
          },
        },
      }),
      tx.hieOutboxEvent.findFirst({
        where: {
          clinicId: params.clinicId,
          aggregateType: "Visit",
          aggregateId: String(params.visitId),
          resourceType: "Encounter",
        },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      }),
    ]);
  if (!(config?.enabled && config.sharedRecordWriteEnabled)) {
    return null;
  }
  if (!(visit && discharge && visit.doctorId && visit.branchId)) {
    throw new HieDependencyError(
      "DISCHARGE_PUBLICATION_DATA_REQUIRED",
      "Discharge summary, doctor, and branch are required"
    );
  }
  const now = new Date();
  const [identity, consent] = await Promise.all([
    tx.patientExternalIdentity.findFirst({
      where: {
        patientId: params.patientId,
        verificationStatus: "VERIFIED",
        resourceIdEncrypted: { not: null },
      },
      select: { id: true },
    }),
    tx.hieConsent.findFirst({
      where: {
        clinicId: params.clinicId,
        patientId: params.patientId,
        status: "ACTIVE",
        syncStatus: "SYNCED",
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      select: { id: true },
    }),
  ]);
  const dependencyReason = patientPublicationDependencyReason(
    Boolean(identity),
    Boolean(consent)
  );
  const remoteEncounterId = existingLink
    ? decryptHieValue(existingLink.hieResourceIdEncrypted)
    : existingEncounterEvent?.id;
  const encounterUpdateKey = hieOutboxIdempotencyKey({
    environment: config.environment,
    clinicId: params.clinicId,
    localResourceType: "Visit",
    localResourceId: String(params.visitId),
    hieResourceType: "Encounter",
    operation: "UPDATE",
  });
  const encounterEvent = await tx.hieOutboxEvent.upsert({
    where: { idempotencyKey: encounterUpdateKey },
    create: {
      clinicId: params.clinicId,
      aggregateType: "Visit",
      aggregateId: String(params.visitId),
      resourceType: "Encounter",
      operation: "UPDATE",
      dependencyOrder: 0,
      payloadEncrypted: encryptHieJson({
        visitId: visit.id,
        patientId: visit.patientId,
        doctorId: visit.doctorId,
        branchId: visit.branchId,
        startedAt: visit.startTime.toISOString(),
        endedAt: (visit.endTime ?? visit.updatedAt).toISOString(),
        resourceId: remoteEncounterId,
      }),
      status: dependencyReason ? "BLOCKED" : "PENDING",
      dependencyReason,
      idempotencyKey: encounterUpdateKey,
      correlationId: randomUUID(),
    },
    update: {},
  });
  const clinicalEvents = await buildExtendedClinicalEvents(
    tx,
    {
      clinicId: params.clinicId,
      visitId: params.visitId,
      patientId: params.patientId,
      doctorId: visit.doctorId,
      branchId: visit.branchId,
    },
    dependencyReason
  );
  if (clinicalEvents.length > 0) {
    const existingClinicalEvents = await tx.hieOutboxEvent.findMany({
      where: {
        clinicId: params.clinicId,
        OR: clinicalEvents.map((event) => ({
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          resourceType: event.resourceType,
        })),
      },
      select: {
        aggregateType: true,
        aggregateId: true,
        resourceType: true,
      },
    });
    const existingKeys = new Set(
      existingClinicalEvents.map(
        (event) =>
          `${event.aggregateType}:${event.aggregateId}:${event.resourceType}`
      )
    );
    const newClinicalEvents = clinicalEvents.filter(
      (event) =>
        !existingKeys.has(
          `${event.aggregateType}:${event.aggregateId}:${event.resourceType}`
        )
    );
    await tx.hieOutboxEvent.createMany({
      data: withIdempotencyKeys(
        newClinicalEvents.map((event) => ({
          ...event,
          dependencyOrder: (event.dependencyOrder ?? 0) + 10,
        })),
        { environment: config.environment, clinicId: params.clinicId }
      ),
      skipDuplicates: true,
    });
  }
  const ipsKey = hieOutboxIdempotencyKey({
    environment: config.environment,
    clinicId: params.clinicId,
    localResourceType: "Hospitalization",
    localResourceId: String(params.hospitalizationId),
    hieResourceType: "Bundle",
    operation: "CREATE",
  });
  await tx.hieOutboxEvent.upsert({
    where: { idempotencyKey: ipsKey },
    create: {
      clinicId: params.clinicId,
      aggregateType: "Hospitalization",
      aggregateId: String(params.hospitalizationId),
      resourceType: "DischargeIPS",
      operation: "CREATE",
      dependencyOrder: 100,
      payloadEncrypted: encryptHieJson({
        hospitalizationId: params.hospitalizationId,
        visitId: params.visitId,
        patientId: params.patientId,
        practitionerId: discharge.dischargedById,
        branchId: visit.branchId,
        authoredAt: discharge.createdAt.toISOString(),
        finalDiagnosis: discharge.finalDiagnosis,
        clinicalSummary: discharge.summary,
        patientInstructions: discharge.patientInstructions,
        followUpAt: discharge.followUpDate?.toISOString() ?? null,
        destination: discharge.destination,
      }),
      status: dependencyReason ? "BLOCKED" : "PENDING",
      dependencyReason,
      idempotencyKey: ipsKey,
      correlationId: randomUUID(),
    },
    update: {},
  });
  return encounterEvent;
}

export async function resumeBlockedPatientEvents(
  tx: Prisma.TransactionClient,
  params: { clinicId: number; patientId: number }
): Promise<number> {
  const now = new Date();
  const [identity, consent] = await Promise.all([
    tx.patientExternalIdentity.findFirst({
      where: {
        patientId: params.patientId,
        verificationStatus: "VERIFIED",
        resourceIdEncrypted: { not: null },
      },
      select: { id: true },
    }),
    tx.hieConsent.findFirst({
      where: {
        clinicId: params.clinicId,
        patientId: params.patientId,
        status: "ACTIVE",
        syncStatus: "SYNCED",
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      select: { id: true },
    }),
  ]);
  if (!(identity && consent)) {
    return 0;
  }

  const [visits, diagnoses, triages] = await Promise.all([
    tx.visit.findMany({
      where: { clinicId: params.clinicId, patientId: params.patientId },
      select: { id: true },
    }),
    tx.visitDiagnosis.findMany({
      where: {
        visit: { clinicId: params.clinicId, patientId: params.patientId },
      },
      select: { id: true },
    }),
    tx.triage.findMany({
      where: {
        visit: { clinicId: params.clinicId, patientId: params.patientId },
      },
      select: { id: true },
    }),
  ]);
  const encryptedClinicalEvents = await tx.hieOutboxEvent.findMany({
    where: {
      clinicId: params.clinicId,
      status: "BLOCKED",
      dependencyReason: { in: [...RESUMABLE_PATIENT_DEPENDENCY_REASONS] },
      resourceType: {
        in: [
          "LAB_REQUEST",
          "LAB_RESULT",
          "MEDICATION_REQUEST",
          "MEDICATION_DISPENSE",
          "MEDICATION_ADMINISTRATION",
          "PROCEDURE",
          "WARD_OBSERVATION",
          "DischargeIPS",
        ],
      },
    },
    select: { id: true, resourceType: true, payloadEncrypted: true },
  });
  const clinicalEventIds = encryptedClinicalEvents.flatMap((event) => {
    const parsed =
      event.resourceType === "DischargeIPS"
        ? dischargeIpsPayloadSchema.safeParse(
            decryptHieJson(event.payloadEncrypted)
          )
        : clinicalSnapshotPayloadSchema.safeParse(
            decryptHieJson(event.payloadEncrypted)
          );
    return parsed.success && parsed.data.patientId === params.patientId
      ? [event.id]
      : [];
  });
  const visitIds = visits.map((visit) => String(visit.id));
  const diagnosisIds = diagnoses.map((diagnosis) => String(diagnosis.id));
  const triageAggregateIds = triages.flatMap((triage) =>
    VITAL_METRICS.map((metric) => `${triage.id}:${metric}`)
  );
  if (
    visitIds.length === 0 &&
    diagnosisIds.length === 0 &&
    triageAggregateIds.length === 0 &&
    clinicalEventIds.length === 0
  ) {
    return 0;
  }

  const resumed = await tx.hieOutboxEvent.updateMany({
    where: {
      clinicId: params.clinicId,
      status: "BLOCKED",
      dependencyReason: { in: [...RESUMABLE_PATIENT_DEPENDENCY_REASONS] },
      OR: [
        { aggregateType: "Visit", aggregateId: { in: visitIds } },
        {
          aggregateType: "VisitDiagnosis",
          aggregateId: { in: diagnosisIds },
        },
        {
          aggregateType: "Triage",
          aggregateId: { in: triageAggregateIds },
        },
        { id: { in: clinicalEventIds } },
      ],
    },
    data: {
      status: "PENDING",
      dependencyReason: null,
      nextAttemptAt: now,
      lockedAt: null,
    },
  });
  return resumed.count;
}

export async function recoverMissingFinalizedVisitEvents(
  client: PrismaClient = db,
  limit = 20
) {
  const candidates = await client.$queryRaw<
    Array<{ clinicId: number; patientId: number; visitId: number }>
  >(Prisma.sql`
    SELECT
      visit.id AS "visitId",
      visit."clinicId",
      visit."patientId"
    FROM "Visit" AS visit
    INNER JOIN "HieTenantConfig" AS config
      ON config."clinicId" = visit."clinicId"
    WHERE visit.status = 'FINALIZED'
      AND visit."updatedAt" <= ${new Date(Date.now() - FINALIZED_VISIT_RECOVERY_DELAY_MS)}
      AND config.enabled = true
      AND config."sharedRecordWriteEnabled" = true
      AND NOT EXISTS (
        SELECT 1
        FROM "HieOutboxEvent" AS event
        WHERE event."clinicId" = visit."clinicId"
          AND event."aggregateType" = 'Visit'
          AND event."aggregateId" = CAST(visit.id AS TEXT)
          AND event."resourceType" = 'Encounter'
          AND event.operation = 'CREATE'
      )
    ORDER BY visit."updatedAt" ASC
    LIMIT ${limit}
  `);
  let recovered = 0;
  for (const candidate of candidates) {
    try {
      const event = await enqueueFinalizedVisit(client, candidate);
      if (event) {
        recovered += 1;
      }
    } catch (error) {
      logger.error("hie.outbox.recovery_enqueue_failed", {
        error,
      });
    }
  }
  return recovered;
}

async function buildVisitEncounter(event: {
  id: string;
  clinicId: number;
  payloadEncrypted: string;
}) {
  const payload = visitPayloadSchema.parse(
    decryptHieJson(event.payloadEncrypted)
  );
  const visit =
    "patientId" in payload
      ? {
          patientId: payload.patientId,
          doctorId: payload.doctorId,
          branchId: payload.branchId,
          startTime: new Date(payload.startedAt),
          endTime: new Date(payload.endedAt),
        }
      : await db.visit.findFirst({
          where: { id: payload.visitId, clinicId: event.clinicId },
          select: {
            patientId: true,
            doctorId: true,
            branchId: true,
            startTime: true,
            endTime: true,
            updatedAt: true,
            status: true,
          },
        });
  if (!visit) {
    throw new HieDependencyError("VISIT_NOT_FOUND", "Visit no longer exists");
  }
  const now = new Date();
  const [activeConsent, patientIdentity] = await Promise.all([
    db.hieConsent.findFirst({
      where: {
        clinicId: event.clinicId,
        patientId: visit.patientId,
        status: "ACTIVE",
        syncStatus: "SYNCED",
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      select: { id: true },
    }),
    db.patientExternalIdentity.findFirst({
      where: {
        patientId: visit.patientId,
        verificationStatus: "VERIFIED",
        resourceIdEncrypted: { not: null },
      },
    }),
  ]);
  if (!activeConsent) {
    throw new HieDependencyError(
      "ACTIVE_CONSENT_REQUIRED",
      "Active HIE sharing consent is required"
    );
  }
  if (!patientIdentity?.resourceIdEncrypted) {
    throw new HieDependencyError(
      "PATIENT_IDENTITY_REQUIRED",
      "Verified Client Registry identity is required"
    );
  }
  if (!(visit.doctorId && visit.branchId)) {
    throw new HieDependencyError(
      "CLINICAL_REFERENCES_REQUIRED",
      "Doctor and branch references are required"
    );
  }
  const [practitioner, facility] = await Promise.all([
    db.userExternalIdentity.findFirst({
      where: {
        userId: visit.doctorId,
        verificationStatus: { in: ["VERIFIED", "MANUAL_ATTESTED"] },
      },
    }),
    db.hieFacilityLink.findFirst({
      where: {
        clinicId: event.clinicId,
        branchId: visit.branchId,
        verificationStatus: { in: ["VERIFIED", "MANUAL_ATTESTED"] },
      },
    }),
  ]);
  if (!practitioner) {
    throw new HieDependencyError(
      "PRACTITIONER_IDENTITY_REQUIRED",
      "Verified national practitioner identity is required"
    );
  }
  if (!facility) {
    throw new HieDependencyError(
      "FACILITY_IDENTITY_REQUIRED",
      "Verified national facility identity is required"
    );
  }
  return mapVisitEncounter({
    id:
      "resourceId" in payload && payload.resourceId
        ? payload.resourceId
        : event.id,
    patientReference: decryptHieValue(patientIdentity.resourceIdEncrypted),
    practitionerReference: decryptHieValue(practitioner.identifierEncrypted),
    locationReference: facility.locationReference,
    startedAt: visit.startTime,
    endedAt:
      "updatedAt" in visit && !visit.endTime && visit.status === "FINALIZED"
        ? visit.updatedAt
        : visit.endTime,
  });
}

async function buildTransferEncounter(event: {
  id: string;
  clinicId: number;
  payloadEncrypted: string;
}) {
  const payload = queuedTransferPayloadSchema.parse(
    decryptHieJson(event.payloadEncrypted)
  );
  const transfer = await db.hieExternalTransfer.findFirst({
    where: {
      id: payload.transferId,
      clinicId: event.clinicId,
      status: "QUEUED",
    },
    include: {
      patient: {
        select: {
          externalIdentities: {
            where: {
              verificationStatus: "VERIFIED",
              resourceIdEncrypted: { not: null },
            },
            take: 1,
          },
        },
      },
      sourceBranch: {
        select: {
          hieFacilityLinks: {
            where: {
              verificationStatus: { in: ["VERIFIED", "MANUAL_ATTESTED"] },
            },
            take: 1,
          },
        },
      },
      referringPractitioner: {
        select: {
          hieExternalIdentities: {
            where: {
              verificationStatus: { in: ["VERIFIED", "MANUAL_ATTESTED"] },
            },
            take: 1,
          },
        },
      },
      destinationFacility: {
        select: { verificationStatus: true },
      },
      visit: { select: { id: true, startTime: true, endTime: true } },
    },
  });
  if (!transfer) {
    throw new HieDependencyError(
      "TRANSFER_NOT_FOUND",
      "External transfer no longer exists"
    );
  }
  const now = new Date();
  const consent = await db.hieConsent.findFirst({
    where: {
      clinicId: event.clinicId,
      patientId: transfer.patientId,
      status: "ACTIVE",
      syncStatus: "SYNCED",
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
  });
  const patientIdentity = transfer.patient.externalIdentities[0];
  const practitioner = transfer.referringPractitioner.hieExternalIdentities[0];
  const facility = transfer.sourceBranch.hieFacilityLinks[0];
  const parentEncounter = await db.hieResourceLink.findUnique({
    where: {
      clinicId_localResourceType_localResourceId_hieResourceType: {
        clinicId: event.clinicId,
        localResourceType: "Visit",
        localResourceId: String(transfer.visitId),
        hieResourceType: "Encounter",
      },
    },
  });
  if (!consent) {
    throw new HieDependencyError(
      "ACTIVE_CONSENT_REQUIRED",
      "Active HIE sharing consent is required"
    );
  }
  if (!patientIdentity?.resourceIdEncrypted) {
    throw new HieDependencyError(
      "PATIENT_IDENTITY_REQUIRED",
      "Verified Client Registry identity is required"
    );
  }
  if (!practitioner) {
    throw new HieDependencyError(
      "PRACTITIONER_IDENTITY_REQUIRED",
      "Verified national practitioner identity is required"
    );
  }
  if (!facility) {
    throw new HieDependencyError(
      "FACILITY_IDENTITY_REQUIRED",
      "Verified source facility identity is required"
    );
  }
  if (
    !(["VERIFIED", "MANUAL_ATTESTED"] as string[]).includes(
      transfer.destinationFacility?.verificationStatus ?? ""
    )
  ) {
    throw new HieDependencyError(
      "DESTINATION_FACILITY_REQUIRED",
      "A verified destination facility is required"
    );
  }
  if (!parentEncounter) {
    throw new HieDependencyError(
      "PARENT_ENCOUNTER_REQUIRED",
      "The parent visit must be published before transfer"
    );
  }
  const snapshot =
    "patientId" in payload
      ? {
          clinicalSummary: payload.clinicalSummary,
          authoredAt: new Date(payload.authoredAt),
          reason: payload.reason,
          destinationLocationReference: payload.destinationLocationReference,
          startedAt: new Date(payload.startedAt),
          endedAt: payload.endedAt ? new Date(payload.endedAt) : null,
        }
      : {
          clinicalSummary: transfer.clinicalSummary,
          authoredAt: transfer.updatedAt,
          reason: transfer.reason,
          destinationLocationReference: transfer.destinationLocationReference,
          startedAt: transfer.visit.startTime,
          endedAt: transfer.visit.endTime,
        };
  return {
    transfer,
    clinicalSummary: snapshot.clinicalSummary,
    authoredAt: snapshot.authoredAt,
    patientReference: decryptHieValue(patientIdentity.resourceIdEncrypted),
    practitionerReference: decryptHieValue(practitioner.identifierEncrypted),
    resource: mapTransferEncounter({
      id: event.id,
      patientReference: decryptHieValue(patientIdentity.resourceIdEncrypted),
      practitionerReference: decryptHieValue(practitioner.identifierEncrypted),
      locationReference: snapshot.destinationLocationReference,
      originReference: facility.locationReference,
      destinationReference: snapshot.destinationLocationReference,
      parentEncounterReference: decryptHieValue(
        parentEncounter.hieResourceIdEncrypted
      ),
      reason: snapshot.reason,
      startedAt: snapshot.startedAt,
      endedAt: snapshot.endedAt,
    }),
  };
}

async function buildVisitCondition(event: {
  id: string;
  clinicId: number;
  payloadEncrypted: string;
}) {
  const payload = conditionPayloadSchema.parse(
    decryptHieJson(event.payloadEncrypted)
  );
  const diagnosis =
    "patientId" in payload
      ? {
          id: payload.diagnosisId,
          visitId: payload.visitId,
          patientId: payload.patientId,
          doctorId: payload.doctorId,
          icd11Code: payload.icd11Code,
          description: payload.description,
          createdAt: new Date(payload.recordedAt),
        }
      : await db.visitDiagnosis
          .findFirst({
            where: {
              id: payload.diagnosisId,
              visit: { clinicId: event.clinicId },
            },
            select: {
              id: true,
              icd11Code: true,
              description: true,
              createdAt: true,
              visitId: true,
              visit: { select: { patientId: true, doctorId: true } },
            },
          })
          .then((result) =>
            result
              ? {
                  id: result.id,
                  visitId: result.visitId,
                  patientId: result.visit.patientId,
                  doctorId: result.visit.doctorId,
                  icd11Code: result.icd11Code,
                  description: result.description,
                  createdAt: result.createdAt,
                }
              : null
          );
  if (!diagnosis?.icd11Code) {
    throw new HieDependencyError(
      "ICD11_CODE_REQUIRED",
      "ICD-11 code is required for Condition publication"
    );
  }
  if (!diagnosis.doctorId) {
    throw new HieDependencyError(
      "PRACTITIONER_IDENTITY_REQUIRED",
      "Visit doctor is required for Condition publication"
    );
  }
  const [practitioner, encounter, consent, patientIdentity] = await Promise.all(
    [
      db.userExternalIdentity.findFirst({
        where: {
          userId: diagnosis.doctorId,
          verificationStatus: { in: ["VERIFIED", "MANUAL_ATTESTED"] },
        },
      }),
      db.hieResourceLink.findUnique({
        where: {
          clinicId_localResourceType_localResourceId_hieResourceType: {
            clinicId: event.clinicId,
            localResourceType: "Visit",
            localResourceId: String(diagnosis.visitId),
            hieResourceType: "Encounter",
          },
        },
      }),
      db.hieConsent.findFirst({
        where: {
          clinicId: event.clinicId,
          patientId: diagnosis.patientId,
          status: "ACTIVE",
          syncStatus: "SYNCED",
          effectiveFrom: { lte: new Date() },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }],
        },
        select: { id: true },
      }),
      db.patientExternalIdentity.findFirst({
        where: {
          patientId: diagnosis.patientId,
          verificationStatus: "VERIFIED",
          resourceIdEncrypted: { not: null },
        },
      }),
    ]
  );
  if (!patientIdentity?.resourceIdEncrypted) {
    throw new HieDependencyError(
      "PATIENT_IDENTITY_REQUIRED",
      "Verified Client Registry identity is required"
    );
  }
  if (!consent) {
    throw new HieDependencyError(
      "ACTIVE_CONSENT_REQUIRED",
      "Active HIE sharing consent is required"
    );
  }
  if (!practitioner) {
    throw new HieDependencyError(
      "PRACTITIONER_IDENTITY_REQUIRED",
      "Verified national practitioner identity is required"
    );
  }
  if (!encounter) {
    throw new HieDependencyError(
      "PARENT_ENCOUNTER_REQUIRED",
      "The visit Encounter must be published before its Conditions"
    );
  }
  return {
    diagnosisId: diagnosis.id,
    resource: mapVisitCondition({
      id: event.id,
      patientReference: decryptHieValue(patientIdentity.resourceIdEncrypted),
      practitionerReference: decryptHieValue(practitioner.identifierEncrypted),
      encounterReference: decryptHieValue(encounter.hieResourceIdEncrypted),
      icd11Code: diagnosis.icd11Code,
      description: diagnosis.description,
      recordedAt: diagnosis.createdAt,
    }),
  };
}

async function buildVitalObservation(event: {
  id: string;
  clinicId: number;
  payloadEncrypted: string;
}) {
  const payload = vitalPayloadSchema.parse(
    decryptHieJson(event.payloadEncrypted)
  );
  const triage =
    "patientId" in payload
      ? {
          id: payload.triageId,
          visitId: payload.visitId,
          patientId: payload.patientId,
          practitionerId: payload.practitionerId,
          rawValue: payload.rawValue,
          createdAt: new Date(payload.effectiveAt),
        }
      : await db.triage
          .findFirst({
            where: {
              id: payload.triageId,
              visit: { clinicId: event.clinicId },
            },
            select: {
              id: true,
              recordedById: true,
              createdAt: true,
              height: true,
              weight: true,
              temperature: true,
              heartRate: true,
              respiratory: true,
              spo2: true,
              bmi: true,
              bloodSugar: true,
              visitId: true,
              visit: { select: { doctorId: true, patientId: true } },
            },
          })
          .then((result) =>
            result
              ? {
                  id: result.id,
                  visitId: result.visitId,
                  patientId: result.visit.patientId,
                  practitionerId: result.recordedById ?? result.visit.doctorId,
                  rawValue: result[payload.metric],
                  createdAt: result.createdAt,
                }
              : null
          );
  if (!triage) {
    throw new HieDependencyError("TRIAGE_NOT_FOUND", "Triage no longer exists");
  }
  const numericValue = triage.rawValue
    ? parseVitalValue(triage.rawValue)
    : null;
  if (numericValue === null) {
    throw new HieDependencyError(
      "VITAL_VALUE_INVALID",
      `A numeric UCUM-compatible value is required for ${payload.metric}`
    );
  }
  const practitionerId = triage.practitionerId;
  if (!practitionerId) {
    throw new HieDependencyError(
      "PRACTITIONER_IDENTITY_REQUIRED",
      "A recorded-by practitioner is required for vital publication"
    );
  }
  const now = new Date();
  const [practitioner, encounter, consent, patientIdentity] = await Promise.all(
    [
      db.userExternalIdentity.findFirst({
        where: {
          userId: practitionerId,
          verificationStatus: { in: ["VERIFIED", "MANUAL_ATTESTED"] },
        },
      }),
      db.hieResourceLink.findUnique({
        where: {
          clinicId_localResourceType_localResourceId_hieResourceType: {
            clinicId: event.clinicId,
            localResourceType: "Visit",
            localResourceId: String(triage.visitId),
            hieResourceType: "Encounter",
          },
        },
      }),
      db.hieConsent.findFirst({
        where: {
          clinicId: event.clinicId,
          patientId: triage.patientId,
          status: "ACTIVE",
          syncStatus: "SYNCED",
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        },
        select: { id: true },
      }),
      db.patientExternalIdentity.findFirst({
        where: {
          patientId: triage.patientId,
          verificationStatus: "VERIFIED",
          resourceIdEncrypted: { not: null },
        },
      }),
    ]
  );
  if (!patientIdentity?.resourceIdEncrypted) {
    throw new HieDependencyError(
      "PATIENT_IDENTITY_REQUIRED",
      "Verified Client Registry identity is required"
    );
  }
  if (!consent) {
    throw new HieDependencyError(
      "ACTIVE_CONSENT_REQUIRED",
      "Active HIE sharing consent is required"
    );
  }
  if (!practitioner) {
    throw new HieDependencyError(
      "PRACTITIONER_IDENTITY_REQUIRED",
      "Verified national practitioner identity is required"
    );
  }
  if (!encounter) {
    throw new HieDependencyError(
      "PARENT_ENCOUNTER_REQUIRED",
      "The visit Encounter must be published before its vital signs"
    );
  }
  return {
    localResourceId: `${triage.id}:${payload.metric}`,
    resource: mapVitalObservation({
      id: event.id,
      metric: payload.metric,
      value: numericValue,
      patientReference: decryptHieValue(patientIdentity.resourceIdEncrypted),
      practitionerReference: decryptHieValue(practitioner.identifierEncrypted),
      encounterReference: decryptHieValue(encounter.hieResourceIdEncrypted),
      effectiveAt: triage.createdAt,
    }),
  };
}

async function resourceAlreadyExists(params: {
  resourceType: string;
  resourceId: string;
  correlationId: string;
  tenantEnvironment: HieEnvironment;
}) {
  try {
    await rhieRequest({
      service: "SHR",
      method: "GET",
      path: `${params.resourceType}/${params.resourceId}`,
      tenantEnvironment: params.tenantEnvironment,
      correlationId: params.correlationId,
    });
    return true;
  } catch (error) {
    if (error instanceof RhieRequestError && error.status === 404) {
      return false;
    }
    throw error;
  }
}

async function postWithRetryVerification(params: {
  eventAttemptCount: number;
  postPath: string;
  resourceType: string;
  resourceId: string;
  body: unknown;
  correlationId: string;
  tenantEnvironment: HieEnvironment;
  verifyOnRetry?: boolean;
}) {
  if (
    params.eventAttemptCount > 0 &&
    params.verifyOnRetry !== false &&
    (await resourceAlreadyExists(params))
  ) {
    return { status: 200 };
  }
  return rhieRequest({
    service: "SHR",
    method: "POST",
    path: params.postPath,
    body: params.body,
    correlationId: params.correlationId,
    tenantEnvironment: params.tenantEnvironment,
  });
}

type ClinicalSnapshot = z.infer<typeof clinicalSnapshotPayloadSchema>;

const clinicalProductSelect = {
  terminologyStatus: true,
  snomedCode: true,
  loincCode: true,
  ichiCode: true,
} as const;

function findCurrentClinicalProduct(payload: ClinicalSnapshot) {
  const [localIdPart, productIdPart] = payload.localResourceId.split(":");
  const localId = Number.parseInt(localIdPart ?? "", 10);
  const productId = Number.parseInt(productIdPart ?? "", 10);
  if (!Number.isFinite(localId)) {
    return null;
  }
  if (
    ["Exam", "Treatment"].includes(payload.localResourceType) &&
    Number.isFinite(productId)
  ) {
    return db.product.findUnique({
      where: { id: productId },
      select: clinicalProductSelect,
    });
  }
  switch (payload.localResourceType) {
    case "ExamResult":
      return db.examResult
        .findUnique({
          where: { id: localId },
          select: { product: { select: clinicalProductSelect } },
        })
        .then((value) => value?.product ?? null);
    case "PrescriptionItem":
      return db.prescriptionItem
        .findUnique({
          where: { id: localId },
          select: {
            pharmacyItemMap: {
              select: {
                inventoryItem: {
                  select: { product: { select: clinicalProductSelect } },
                },
              },
            },
          },
        })
        .then((value) => value?.pharmacyItemMap?.inventoryItem.product ?? null);
    case "PharmacyDispenseLine":
      return db.pharmacyDispenseLine
        .findUnique({
          where: { id: localId },
          select: {
            inventoryItem: {
              select: { product: { select: clinicalProductSelect } },
            },
          },
        })
        .then((value) => value?.inventoryItem.product ?? null);
    case "WardMedication":
      return db.wardMedication
        .findUnique({
          where: { id: localId },
          select: { product: { select: clinicalProductSelect } },
        })
        .then((value) => value?.product ?? null);
    case "WardMedicationAdministration":
      return db.wardMedicationAdministration
        .findUnique({
          where: { id: localId },
          select: {
            wardMedication: {
              select: { product: { select: clinicalProductSelect } },
            },
          },
        })
        .then((value) => value?.wardMedication.product ?? null);
    default:
      return null;
  }
}

function clinicalCodeForProduct(
  kind: ClinicalSnapshot["kind"],
  product: NonNullable<Awaited<ReturnType<typeof findCurrentClinicalProduct>>>
) {
  if (kind === "LAB_RESULT") {
    return product.loincCode;
  }
  if (kind === "PROCEDURE") {
    return product.ichiCode;
  }
  return product.snomedCode;
}

type ClinicalReferenceBase = {
  id: string;
  patientReference: string;
  practitionerReference: string;
  encounterReference: string;
  locationReference: string;
  code: string;
  display: string;
  coverageReference?: string;
};

function resolvedStructuredDosage(payload: ClinicalSnapshot) {
  const parsed = z
    .object({
      dosage: z.string().min(1),
      doseValue: z.number().positive(),
      doseUnit: z.string().min(1),
      frequencyCount: z.number().int().positive(),
      frequencyPeriod: z.number().positive(),
      frequencyPeriodUnit: medicationPeriodUnitSchema,
      routeSystem: z.string().min(1),
      routeCode: z.string().min(1),
      routeDisplay: z.string().min(1),
      methodSystem: z.string().min(1).optional(),
      methodCode: z.string().min(1).optional(),
      methodDisplay: z.string().min(1).optional(),
      durationValue: z.number().positive(),
      durationUnit: medicationPeriodUnitSchema,
    })
    .safeParse(payload);
  if (!parsed.success) {
    throw new HieDependencyError(
      "STRUCTURED_MEDICATION_DOSAGE_REQUIRED",
      "Structured dose, frequency, route, and duration are required"
    );
  }
  return { text: parsed.data.dosage, ...parsed.data };
}

function resolvedAdministrationDosage(payload: ClinicalSnapshot) {
  const dosage = resolvedStructuredDosage(payload);
  const method = z
    .object({
      methodSystem: z.string().min(1),
      methodCode: z.string().min(1),
      methodDisplay: z.string().min(1),
    })
    .safeParse(payload);
  if (!method.success) {
    throw new HieDependencyError(
      "STRUCTURED_MEDICATION_METHOD_REQUIRED",
      "A structured medication administration method is required"
    );
  }
  return { ...dosage, ...method.data };
}

function mapResolvedMedicationResource(params: {
  payload: ClinicalSnapshot;
  base: ClinicalReferenceBase;
  relatedReference: string | undefined;
}) {
  const { payload, base, relatedReference } = params;
  switch (payload.kind) {
    case "MEDICATION_REQUEST":
      if (!(payload.groupIdentifier && base.coverageReference)) {
        throw new HieDependencyError(
          "COVERAGE_REFERENCE_REQUIRED",
          "A verified national Coverage reference is required"
        );
      }
      return {
        payload,
        resourceType: "MedicationRequest",
        postPath: "MedicationRequest",
        resource: mapMedicationRequest({
          ...base,
          authoredAt: new Date(payload.clinicalAt),
          groupIdentifier: payload.groupIdentifier,
          coverageReference: base.coverageReference,
          dosage: resolvedStructuredDosage(payload),
        }),
      };
    case "MEDICATION_DISPENSE":
      if (!relatedReference) {
        throw new HieDependencyError(
          "MEDICATION_REQUEST_REFERENCE_REQUIRED",
          "The authorizing MedicationRequest must be published first"
        );
      }
      return {
        payload,
        resourceType: "MedicationDispense",
        postPath: "MedicationDispense",
        resource: mapMedicationDispense({
          ...base,
          handedOverAt: new Date(payload.clinicalAt),
          quantity: payload.quantity ?? 1,
          unit: payload.unit ?? "unit",
          dosage: resolvedStructuredDosage(payload),
          medicationRequestReference: relatedReference,
        }),
      };
    case "MEDICATION_ADMINISTRATION":
      if (!relatedReference) {
        throw new HieDependencyError(
          "MEDICATION_REQUEST_REFERENCE_REQUIRED",
          "The supporting MedicationRequest must be published first"
        );
      }
      return {
        payload,
        resourceType: "MedicationAdministration",
        postPath: "MedicationAdministration",
        resource: mapMedicationAdministration({
          ...base,
          effectiveAt: new Date(payload.clinicalAt),
          reason: payload.reason ?? "Medication administered as prescribed",
          dosage: resolvedAdministrationDosage(payload),
          medicationRequestReference: relatedReference,
        }),
      };
    default:
      return null;
  }
}

function mapResolvedClinicalResource(params: {
  payload: ClinicalSnapshot;
  base: ClinicalReferenceBase;
  relatedReference: string | undefined;
}) {
  const medication = mapResolvedMedicationResource(params);
  if (medication) {
    return medication;
  }
  const { payload, base, relatedReference } = params;
  switch (payload.kind) {
    case "LAB_REQUEST":
      return {
        payload,
        resourceType: "ServiceRequest",
        postPath: "ServiceRequest/lab",
        resource: mapLabServiceRequest({
          ...base,
          orderedAt: new Date(payload.clinicalAt),
        }),
      };
    case "LAB_RESULT":
      if (!payload.value) {
        throw new HieDependencyError(
          "LAB_RESULT_VALUE_REQUIRED",
          "A finalized lab result value is required"
        );
      }
      return {
        payload,
        resourceType: "Observation",
        postPath: "Observation/lab-results",
        resource: mapLabResultObservation({
          ...base,
          effectiveAt: new Date(payload.clinicalAt),
          value: payload.value,
          unit: payload.unit,
          serviceRequestReference: relatedReference,
        }),
      };
    case "PROCEDURE":
      return {
        payload,
        resourceType: "Procedure",
        postPath: "Procedure",
        resource: mapProcedure({
          ...base,
          performedAt: new Date(payload.clinicalAt),
        }),
      };
    case "WARD_OBSERVATION": {
      const numericValue = payload.value
        ? parseVitalValue(payload.value)
        : null;
      if (!(payload.metric && numericValue !== null)) {
        throw new HieDependencyError(
          "VITAL_VALUE_INVALID",
          "A numeric UCUM-compatible ward observation is required"
        );
      }
      return {
        payload,
        resourceType: "Observation",
        postPath: "Observation/vital-signs",
        resource: mapVitalObservation({
          id: base.id,
          metric: payload.metric,
          value: numericValue,
          patientReference: base.patientReference,
          practitionerReference: base.practitionerReference,
          encounterReference: base.encounterReference,
          effectiveAt: new Date(payload.clinicalAt),
        }),
      };
    }
    default:
      throw new HieDependencyError(
        "CLINICAL_RESOURCE_UNSUPPORTED",
        "The clinical resource type is not supported"
      );
  }
}

function assertClinicalDependency<T>(
  value: T,
  code: string,
  message: string
): asserts value is NonNullable<T> {
  if (value == null || value === false) {
    throw new HieDependencyError(code, message);
  }
}

async function resolveClinicalTerminologyCode(payload: ClinicalSnapshot) {
  if (payload.kind === "WARD_OBSERVATION") {
    return payload.code;
  }
  let resolvedCode = payload.code;
  let resolvedStatus = payload.terminologyStatus;
  if (!(resolvedCode && resolvedStatus === "VERIFIED")) {
    const product = await findCurrentClinicalProduct(payload);
    if (product?.terminologyStatus === "VERIFIED") {
      resolvedStatus = product.terminologyStatus;
      resolvedCode = clinicalCodeForProduct(payload.kind, product);
    }
  }
  if (!(resolvedCode && resolvedStatus === "VERIFIED")) {
    throw new HieDependencyError(
      "VERIFIED_TERMINOLOGY_REQUIRED",
      "A platform-verified terminology mapping is required"
    );
  }
  return resolvedCode;
}

async function assertVerifiedMedicationConcepts(payload: ClinicalSnapshot) {
  const medicationKinds = [
    "MEDICATION_REQUEST",
    "MEDICATION_DISPENSE",
    "MEDICATION_ADMINISTRATION",
  ];
  if (!medicationKinds.includes(payload.kind)) {
    return;
  }
  const route =
    payload.routeSystem && payload.routeCode
      ? await db.hieClinicalConcept.findFirst({
          where: {
            domain: "MEDICATION_ROUTE",
            codingSystem: payload.routeSystem,
            code: payload.routeCode,
            status: "VERIFIED",
            active: true,
          },
          select: { id: true },
        })
      : null;
  if (!route) {
    throw new HieDependencyError(
      "VERIFIED_MEDICATION_ROUTE_REQUIRED",
      "A platform-verified medication route is required"
    );
  }
  if (payload.kind !== "MEDICATION_ADMINISTRATION") {
    return;
  }
  const method =
    payload.methodSystem && payload.methodCode
      ? await db.hieClinicalConcept.findFirst({
          where: {
            domain: "ADMINISTRATION_METHOD",
            codingSystem: payload.methodSystem,
            code: payload.methodCode,
            status: "VERIFIED",
            active: true,
          },
          select: { id: true },
        })
      : null;
  if (!method) {
    throw new HieDependencyError(
      "VERIFIED_ADMINISTRATION_METHOD_REQUIRED",
      "A platform-verified medication administration method is required"
    );
  }
}

async function buildClinicalResource(event: {
  id: string;
  clinicId: number;
  payloadEncrypted: string;
}) {
  const payload = clinicalSnapshotPayloadSchema.parse(
    decryptHieJson(event.payloadEncrypted)
  );
  const resolvedCode = await resolveClinicalTerminologyCode(payload);
  if (!(payload.practitionerId && payload.branchId)) {
    throw new HieDependencyError(
      "CLINICAL_REFERENCES_REQUIRED",
      "Practitioner and branch references are required"
    );
  }
  await assertVerifiedMedicationConcepts(payload);
  const now = new Date();
  const [
    identity,
    consent,
    practitioner,
    facility,
    encounter,
    related,
    coverage,
  ] = await Promise.all([
    db.patientExternalIdentity.findFirst({
      where: {
        patientId: payload.patientId,
        verificationStatus: "VERIFIED",
        resourceIdEncrypted: { not: null },
      },
      orderBy: { verifiedAt: "desc" },
    }),
    db.hieConsent.findFirst({
      where: {
        clinicId: event.clinicId,
        patientId: payload.patientId,
        status: "ACTIVE",
        syncStatus: "SYNCED",
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      select: { id: true },
    }),
    db.userExternalIdentity.findFirst({
      where: {
        userId: payload.practitionerId,
        verificationStatus: { in: ["VERIFIED", "MANUAL_ATTESTED"] },
      },
    }),
    db.hieFacilityLink.findFirst({
      where: {
        clinicId: event.clinicId,
        branchId: payload.branchId,
        verificationStatus: { in: ["VERIFIED", "MANUAL_ATTESTED"] },
      },
    }),
    db.hieResourceLink.findUnique({
      where: {
        clinicId_localResourceType_localResourceId_hieResourceType: {
          clinicId: event.clinicId,
          localResourceType: "Visit",
          localResourceId: String(payload.visitId),
          hieResourceType: "Encounter",
        },
      },
    }),
    payload.relatedLocalResourceType && payload.relatedLocalResourceId
      ? db.hieResourceLink.findFirst({
          where: {
            clinicId: event.clinicId,
            localResourceType: payload.relatedLocalResourceType,
            localResourceId: payload.relatedLocalResourceId,
          },
        })
      : Promise.resolve(null),
    payload.kind === "MEDICATION_REQUEST"
      ? db.visit.findFirst({
          where: { id: payload.visitId, clinicId: event.clinicId },
          select: {
            patientInsurance: {
              select: {
                hieExternalIdentities: {
                  where: {
                    clinicId: event.clinicId,
                    verificationStatus: { in: ["VERIFIED", "MANUAL_ATTESTED"] },
                    OR: [
                      { verificationExpiresAt: null },
                      { verificationExpiresAt: { gt: now } },
                    ],
                  },
                  take: 1,
                },
              },
            },
          },
        })
      : Promise.resolve(null),
  ]);
  assertClinicalDependency(
    identity?.resourceIdEncrypted,
    "PATIENT_IDENTITY_REQUIRED",
    "Verified Client Registry identity is required"
  );
  assertClinicalDependency(
    consent,
    "ACTIVE_CONSENT_REQUIRED",
    "Active HIE sharing consent is required"
  );
  assertClinicalDependency(
    practitioner,
    "PRACTITIONER_IDENTITY_REQUIRED",
    "Verified national practitioner identity is required"
  );
  assertClinicalDependency(
    facility,
    "FACILITY_IDENTITY_REQUIRED",
    "Verified national facility identity is required"
  );
  assertClinicalDependency(
    encounter,
    "PARENT_ENCOUNTER_REQUIRED",
    "The visit Encounter must be published first"
  );
  const base = {
    id: event.id,
    patientReference: decryptHieValue(identity.resourceIdEncrypted),
    practitionerReference: decryptHieValue(practitioner.identifierEncrypted),
    encounterReference: decryptHieValue(encounter.hieResourceIdEncrypted),
    locationReference: facility.locationReference,
    code: resolvedCode ?? "not-applicable",
    display: payload.display,
    coverageReference: coverage?.patientInsurance?.hieExternalIdentities[0]
      ?.coverageReferenceEncrypted
      ? decryptHieValue(
          coverage.patientInsurance.hieExternalIdentities[0]
            .coverageReferenceEncrypted
        )
      : undefined,
  };
  const relatedReference = related
    ? decryptHieValue(related.hieResourceIdEncrypted)
    : undefined;
  return mapResolvedClinicalResource({ payload, base, relatedReference });
}

async function completeClinicalEvent(params: {
  event: { id: string; clinicId: number; attemptCount: number };
  localResourceType: string;
  localResourceId: string;
  hieResourceType: string;
  hieResourceId: string;
  httpStatus: number;
  startedAt: number;
}) {
  await db.$transaction(async (tx) => {
    await tx.hieResourceLink.upsert({
      where: {
        clinicId_localResourceType_localResourceId_hieResourceType: {
          clinicId: params.event.clinicId,
          localResourceType: params.localResourceType,
          localResourceId: params.localResourceId,
          hieResourceType: params.hieResourceType,
        },
      },
      create: {
        clinicId: params.event.clinicId,
        localResourceType: params.localResourceType,
        localResourceId: params.localResourceId,
        hieResourceType: params.hieResourceType,
        hieResourceIdHash: hashHieIdentifier(params.hieResourceId),
        hieResourceIdEncrypted: encryptHieValue(params.hieResourceId),
        lastSyncedAt: new Date(),
      },
      update: { lastSyncedAt: new Date() },
    });
    await tx.hieSyncAttempt.create({
      data: {
        eventId: params.event.id,
        attemptNumber: params.event.attemptCount + 1,
        httpStatus: params.httpStatus,
        outcome: "SUCCEEDED",
        durationMs: Date.now() - params.startedAt,
      },
    });
    await tx.hieOutboxEvent.update({
      where: { id: params.event.id },
      data: {
        status: "SUCCEEDED",
        attemptCount: { increment: 1 },
        completedAt: new Date(),
        lockedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
  });
}

async function buildDischargeIps(event: {
  id: string;
  clinicId: number;
  payloadEncrypted: string;
}) {
  const payload = dischargeIpsPayloadSchema.parse(
    decryptHieJson(event.payloadEncrypted)
  );
  const [identity, practitioner, encounter] = await Promise.all([
    db.patientExternalIdentity.findFirst({
      where: {
        patientId: payload.patientId,
        verificationStatus: "VERIFIED",
        resourceIdEncrypted: { not: null },
      },
      orderBy: { verifiedAt: "desc" },
    }),
    db.userExternalIdentity.findFirst({
      where: {
        userId: payload.practitionerId,
        verificationStatus: { in: ["VERIFIED", "MANUAL_ATTESTED"] },
      },
    }),
    db.hieResourceLink.findUnique({
      where: {
        clinicId_localResourceType_localResourceId_hieResourceType: {
          clinicId: event.clinicId,
          localResourceType: "Visit",
          localResourceId: String(payload.visitId),
          hieResourceType: "Encounter",
        },
      },
    }),
  ]);
  if (!identity?.resourceIdEncrypted) {
    throw new HieDependencyError(
      "PATIENT_IDENTITY_REQUIRED",
      "Verified Client Registry identity is required"
    );
  }
  if (!practitioner) {
    throw new HieDependencyError(
      "PRACTITIONER_IDENTITY_REQUIRED",
      "Verified discharging practitioner identity is required"
    );
  }
  if (!encounter) {
    throw new HieDependencyError(
      "PARENT_ENCOUNTER_REQUIRED",
      "The discharged Encounter must be published first"
    );
  }
  return {
    payload,
    resource: mapDischargeIpsBundle({
      id: event.id,
      patientReference: decryptHieValue(identity.resourceIdEncrypted),
      practitionerReference: decryptHieValue(practitioner.identifierEncrypted),
      encounterReference: decryptHieValue(encounter.hieResourceIdEncrypted),
      authoredAt: new Date(payload.authoredAt),
      finalDiagnosis: payload.finalDiagnosis,
      clinicalSummary: payload.clinicalSummary,
      patientInstructions: payload.patientInstructions,
      followUpAt: payload.followUpAt ? new Date(payload.followUpAt) : null,
      destination: payload.destination,
    }),
  };
}

async function resolveDeferredClinicalReferences(params: {
  clinicId: number;
  patientId: number;
  practitionerId: number;
  performerId?: number;
  branchId: number;
  visitId?: number | null;
}) {
  const now = new Date();
  const [identity, consent, practitioner, performer, facility, encounter] =
    await Promise.all([
      db.patientExternalIdentity.findFirst({
        where: {
          patientId: params.patientId,
          verificationStatus: "VERIFIED",
          resourceIdEncrypted: { not: null },
        },
      }),
      db.hieConsent.findFirst({
        where: {
          clinicId: params.clinicId,
          patientId: params.patientId,
          status: "ACTIVE",
          syncStatus: "SYNCED",
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        },
      }),
      db.userExternalIdentity.findFirst({
        where: {
          userId: params.practitionerId,
          verificationStatus: { in: ["VERIFIED", "MANUAL_ATTESTED"] },
        },
      }),
      params.performerId
        ? db.userExternalIdentity.findFirst({
            where: {
              userId: params.performerId,
              verificationStatus: { in: ["VERIFIED", "MANUAL_ATTESTED"] },
            },
          })
        : Promise.resolve(null),
      db.hieFacilityLink.findFirst({
        where: {
          clinicId: params.clinicId,
          branchId: params.branchId,
          verificationStatus: { in: ["VERIFIED", "MANUAL_ATTESTED"] },
        },
      }),
      params.visitId
        ? db.hieResourceLink.findUnique({
            where: {
              clinicId_localResourceType_localResourceId_hieResourceType: {
                clinicId: params.clinicId,
                localResourceType: "Visit",
                localResourceId: String(params.visitId),
                hieResourceType: "Encounter",
              },
            },
          })
        : Promise.resolve(null),
    ]);
  assertClinicalDependency(
    identity?.resourceIdEncrypted,
    "PATIENT_IDENTITY_REQUIRED",
    "Verified Client Registry identity is required"
  );
  assertClinicalDependency(
    consent,
    "SYNCHRONIZED_CONSENT_REQUIRED",
    "A synchronized active national Consent is required"
  );
  assertClinicalDependency(
    practitioner,
    "PRACTITIONER_IDENTITY_REQUIRED",
    "Verified national practitioner identity is required"
  );
  if (params.performerId) {
    assertClinicalDependency(
      performer,
      "PERFORMER_IDENTITY_REQUIRED",
      "Verified national performer identity is required"
    );
  }
  assertClinicalDependency(
    facility,
    "FACILITY_IDENTITY_REQUIRED",
    "Verified national facility identity is required"
  );
  if (params.visitId) {
    assertClinicalDependency(
      encounter,
      "PARENT_ENCOUNTER_REQUIRED",
      "The visit Encounter must be published first"
    );
  }
  return {
    patientReference: decryptHieValue(identity.resourceIdEncrypted),
    practitionerReference: decryptHieValue(practitioner.identifierEncrypted),
    performerReference: performer
      ? decryptHieValue(performer.identifierEncrypted)
      : undefined,
    locationReference: facility.locationReference,
    encounterReference: encounter
      ? decryptHieValue(encounter.hieResourceIdEncrypted)
      : undefined,
  };
}

type DeferredClinicalContext = {
  id: string;
  clinicId: number;
  localId: number;
};

async function buildDeferredAllergyResource(event: DeferredClinicalContext) {
  const record = await db.hieStructuredAllergy.findFirst({
    where: { id: event.localId, clinicId: event.clinicId, status: "FINAL" },
    include: { allergen: true },
  });
  if (!(record && record.allergen.status === "VERIFIED")) {
    throw new HieDependencyError(
      "VERIFIED_TERMINOLOGY_REQUIRED",
      "A finalized allergy with verified terminology is required"
    );
  }
  const references = await resolveDeferredClinicalReferences({
    clinicId: event.clinicId,
    patientId: record.patientId,
    practitionerId: record.asserterId,
    branchId: record.branchId,
    visitId: record.visitId,
  });
  const reactions = z
    .array(allergyReactionSchema)
    .catch([])
    .parse(record.reactions);
  return {
    localResourceType: "HieStructuredAllergy",
    localResourceId: String(record.id),
    resourceType: "AllergyIntolerance",
    postPath: "AllergyIntolerance",
    resource: mapStructuredAllergy({
      id: event.id,
      ...references,
      allergen: {
        system: record.allergen.codingSystem,
        code: record.allergen.code,
        display: record.allergen.display,
      },
      clinicalStatus: record.clinicalStatus,
      verificationStatus: record.verificationStatus,
      criticality: record.criticality,
      onsetAt: record.onsetAt,
      recordedDate: record.recordedDate,
      reactions,
    }),
  };
}

async function buildDeferredImmunizationResource(
  event: DeferredClinicalContext
) {
  const record = await db.hieImmunization.findFirst({
    where: { id: event.localId, clinicId: event.clinicId, status: "FINAL" },
    include: { vaccine: true },
  });
  if (!(record && record.vaccine.status === "VERIFIED")) {
    throw new HieDependencyError(
      "VERIFIED_TERMINOLOGY_REQUIRED",
      "A finalized immunization with verified terminology is required"
    );
  }
  const references = await resolveDeferredClinicalReferences({
    clinicId: event.clinicId,
    patientId: record.patientId,
    practitionerId: record.performerId,
    branchId: record.branchId,
    visitId: record.visitId,
  });
  return {
    localResourceType: "HieImmunization",
    localResourceId: String(record.id),
    resourceType: "Immunization",
    postPath: "Immunization",
    resource: mapStructuredImmunization({
      id: event.id,
      ...references,
      vaccine: {
        system: record.vaccine.codingSystem,
        code: record.vaccine.code,
        display: record.vaccine.display,
      },
      status: record.immunizationStatus as "completed" | "not-done",
      occurrenceAt: record.occurrenceAt,
      lotNumber: record.lotNumber,
      expiryDate: record.expiryDate,
      siteCode: record.siteCode,
      routeCode: record.routeCode,
    }),
  };
}

async function buildDeferredImagingOrderResource(
  event: DeferredClinicalContext
) {
  const record = await db.hieImagingOrder.findFirst({
    where: {
      id: event.localId,
      clinicId: event.clinicId,
      status: "ACTIVE",
    },
    include: { procedureConcept: true, reasonConcept: true },
  });
  if (
    !(
      record &&
      record.procedureConcept.status === "VERIFIED" &&
      record.reasonConcept.status === "VERIFIED"
    )
  ) {
    throw new HieDependencyError(
      "VERIFIED_TERMINOLOGY_REQUIRED",
      "A finalized imaging order with verified terminology is required"
    );
  }
  const references = await resolveDeferredClinicalReferences({
    clinicId: event.clinicId,
    patientId: record.patientId,
    practitionerId: record.requesterId,
    performerId: record.performerId,
    branchId: record.branchId,
    visitId: record.visitId,
  });
  return {
    localResourceType: "HieImagingOrder",
    localResourceId: String(record.id),
    resourceType: "ServiceRequest",
    postPath: "ServiceRequest/imaging",
    resource: mapImagingServiceRequest({
      id: event.id,
      ...references,
      procedure: {
        system: record.procedureConcept.codingSystem,
        code: record.procedureConcept.code,
        display: record.procedureConcept.display,
      },
      reason: {
        system: record.reasonConcept.codingSystem,
        code: record.reasonConcept.code,
        display: record.reasonConcept.display,
      },
      occurrenceAt: record.occurrenceAt,
    }),
  };
}

async function buildDeferredImagingStudyResource(
  event: DeferredClinicalContext
) {
  const record = await db.hieImagingStudy.findFirst({
    where: {
      id: event.localId,
      clinicId: event.clinicId,
      status: "AVAILABLE",
    },
    include: {
      procedureConcept: true,
      reasonConcept: true,
      series: { include: { bodySiteConcept: true, instances: true } },
    },
  });
  if (
    !(
      record &&
      record.procedureConcept.status === "VERIFIED" &&
      record.reasonConcept.status === "VERIFIED" &&
      record.series.every(
        (series) =>
          !series.bodySiteConcept ||
          series.bodySiteConcept.status === "VERIFIED"
      )
    )
  ) {
    throw new HieDependencyError(
      "VERIFIED_TERMINOLOGY_REQUIRED",
      "An available imaging study with verified terminology is required"
    );
  }
  const references = await resolveDeferredClinicalReferences({
    clinicId: event.clinicId,
    patientId: record.patientId,
    practitionerId: record.practitionerId,
    branchId: record.branchId,
    visitId: record.visitId,
  });
  return {
    localResourceType: "HieImagingStudy",
    localResourceId: String(record.id),
    resourceType: "ImagingStudy",
    postPath: "ImagingStudy",
    resource: mapImagingStudy({
      id: event.id,
      ...references,
      procedure: {
        system: record.procedureConcept.codingSystem,
        code: record.procedureConcept.code,
        display: record.procedureConcept.display,
      },
      reason: {
        system: record.reasonConcept.codingSystem,
        code: record.reasonConcept.code,
        display: record.reasonConcept.display,
      },
      studyUid: record.studyUid,
      modality: record.modality,
      description: record.description,
      conclusion: record.conclusion,
      conclusionCode: record.conclusionCode,
      startedAt: record.startedAt,
      series: record.series.map((series) => ({
        uid: series.seriesUid,
        modality: series.modality,
        bodySiteCode: series.bodySiteCode,
        bodySite: series.bodySiteConcept
          ? {
              system: series.bodySiteConcept.codingSystem,
              code: series.bodySiteConcept.code,
              display: series.bodySiteConcept.display,
            }
          : null,
        description: series.description,
        instances: series.instances.map((instance) => ({
          uid: instance.sopUid,
          sopClassUid: instance.sopClassUid,
          number: instance.instanceNumber,
          title: instance.title,
        })),
      })),
    }),
  };
}

function buildDeferredClinicalResource(event: {
  id: string;
  clinicId: number;
  resourceType: string;
  payloadEncrypted: string;
}) {
  const payload = deferredClinicalPayloadSchema.parse(
    decryptHieJson(event.payloadEncrypted)
  );
  const context: DeferredClinicalContext = {
    id: event.id,
    clinicId: event.clinicId,
    localId: payload.localId,
  };
  if (event.resourceType === "AllergyIntolerance") {
    return buildDeferredAllergyResource(context);
  }
  if (event.resourceType === "Immunization") {
    return buildDeferredImmunizationResource(context);
  }
  if (event.resourceType === "ImagingOrder") {
    return buildDeferredImagingOrderResource(context);
  }
  if (event.resourceType === "ImagingStudy") {
    return buildDeferredImagingStudyResource(context);
  }
  throw new HieDependencyError(
    "DEFERRED_CLINICAL_RESOURCE_UNSUPPORTED",
    "Deferred clinical resource is not supported"
  );
}

async function buildConsultationResource(event: {
  id: string;
  clinicId: number;
  aggregateId: string;
  resourceType: string;
  payloadEncrypted: string;
}) {
  if (event.resourceType === "ConsultationEncounter") {
    const payload = legacyVisitPayloadSchema.parse(
      decryptHieJson(event.payloadEncrypted)
    );
    const visit = await db.visit.findFirst({
      where: {
        id: payload.visitId,
        clinicId: event.clinicId,
        status: {
          in: ["FINALIZED", "DISCHARGED", "DISCHARGED_WITH_PRESCRIPTION"],
        },
      },
      select: {
        id: true,
        patientId: true,
        doctorId: true,
        branchId: true,
        startTime: true,
        endTime: true,
        updatedAt: true,
      },
    });
    if (!(visit?.doctorId && visit.branchId)) {
      throw new HieDependencyError(
        "CONSULTATION_REFERENCES_REQUIRED",
        "A finalized consultation with doctor and branch is required"
      );
    }
    const references = await resolveDeferredClinicalReferences({
      clinicId: event.clinicId,
      patientId: visit.patientId,
      practitionerId: visit.doctorId,
      branchId: visit.branchId,
      visitId: visit.id,
    });
    if (!references.encounterReference) {
      throw new HieDependencyError(
        "PARENT_ENCOUNTER_REQUIRED",
        "The visit Encounter must be published before the consultation"
      );
    }
    return {
      localResourceType: "VisitConsultation",
      localResourceId: String(visit.id),
      resourceType: "Encounter",
      postPath: "Encounter/consultation",
      resource: mapConsultationEncounter({
        id: event.id,
        patientReference: references.patientReference,
        practitionerReference: references.practitionerReference,
        parentEncounterReference: references.encounterReference,
        locationReference: references.locationReference,
        startedAt: visit.startTime,
        endedAt: visit.endTime ?? visit.updatedAt,
      }),
    };
  }
  const payload = deferredClinicalPayloadSchema.parse(
    decryptHieJson(event.payloadEncrypted)
  );
  const observation = await db.hieConsultationObservation.findFirst({
    where: { id: payload.localId, clinicId: event.clinicId, status: "FINAL" },
    include: { concept: true },
  });
  if (!(observation && observation.concept.status === "VERIFIED")) {
    throw new HieDependencyError(
      "CONSULTATION_OBSERVATION_NOT_READY",
      "A finalized observation with verified terminology is required"
    );
  }
  const references = await resolveDeferredClinicalReferences({
    clinicId: event.clinicId,
    patientId: observation.patientId,
    practitionerId: observation.practitionerId,
    branchId: observation.branchId,
    visitId: observation.visitId,
  });
  const consultationLink = await db.hieResourceLink.findUnique({
    where: {
      clinicId_localResourceType_localResourceId_hieResourceType: {
        clinicId: event.clinicId,
        localResourceType: "VisitConsultation",
        localResourceId: String(observation.visitId),
        hieResourceType: "Encounter",
      },
    },
  });
  if (!consultationLink) {
    throw new HieDependencyError(
      "CONSULTATION_ENCOUNTER_REQUIRED",
      "The consultation Encounter must be published first"
    );
  }
  return {
    localResourceType: "HieConsultationObservation",
    localResourceId: String(observation.id),
    resourceType: "Observation",
    postPath: "Observation/consultation",
    resource: mapConsultationObservation({
      id: event.id,
      patientReference: references.patientReference,
      practitionerReference: references.practitionerReference,
      encounterReference: decryptHieValue(
        consultationLink.hieResourceIdEncrypted
      ),
      codingSystem: observation.concept.codingSystem,
      code: observation.concept.code,
      display: observation.concept.display,
      category: observation.category,
      valueText: observation.valueText ?? undefined,
      valueNumber: observation.valueNumber
        ? Number(observation.valueNumber)
        : undefined,
      unit: observation.unit ?? undefined,
      clinicalAt: observation.clinicalAt,
    }),
  };
}

type OutboxEventRecord = {
  id: string;
  clinicId: number;
  aggregateType: string;
  aggregateId: string;
  resourceType: string;
  payloadEncrypted: string;
  correlationId: string;
  attemptCount: number;
  operation: string;
};

type HieEnvironment = "TEST" | "PRODUCTION";

type PublicationCapabilityConfig = {
  enabled: boolean;
  sharedRecordWriteEnabled: boolean;
  transferEnabled: boolean;
  consentSyncEnabled: boolean;
  consultationWriteEnabled: boolean;
  allergyWriteEnabled: boolean;
  immunizationWriteEnabled: boolean;
  imagingWriteEnabled: boolean;
};

const CONSULTATION_RESOURCE_TYPES = [
  "ConsultationEncounter",
  "ConsultationObservation",
];

const DEFERRED_CLINICAL_RESOURCE_TYPES = [
  "AllergyIntolerance",
  "Immunization",
  "ImagingOrder",
  "ImagingStudy",
];

const CLINICAL_SNAPSHOT_RESOURCE_TYPES = new Set([
  "LAB_REQUEST",
  "LAB_RESULT",
  "MEDICATION_REQUEST",
  "MEDICATION_DISPENSE",
  "MEDICATION_ADMINISTRATION",
  "PROCEDURE",
  "WARD_OBSERVATION",
]);

const PUBLICATION_CAPABILITY_BY_RESOURCE: Record<
  string,
  Exclude<keyof PublicationCapabilityConfig, "enabled">
> = {
  TransferEncounter: "transferEnabled",
  TransferIPS: "transferEnabled",
  Consent: "consentSyncEnabled",
  ConsultationEncounter: "consultationWriteEnabled",
  ConsultationObservation: "consultationWriteEnabled",
  AllergyIntolerance: "allergyWriteEnabled",
  Immunization: "immunizationWriteEnabled",
  ImagingOrder: "imagingWriteEnabled",
  ImagingStudy: "imagingWriteEnabled",
};

export function publicationCapabilityEnabled(
  config: PublicationCapabilityConfig,
  resourceType: string
) {
  if (!config.enabled) {
    return false;
  }
  const capability =
    PUBLICATION_CAPABILITY_BY_RESOURCE[resourceType] ??
    "sharedRecordWriteEnabled";
  return config[capability];
}

function remoteHieResourceType(resourceType: string) {
  switch (resourceType) {
    case "LAB_REQUEST":
      return "ServiceRequest";
    case "LAB_RESULT":
    case "WARD_OBSERVATION":
      return "Observation";
    case "MEDICATION_REQUEST":
      return "MedicationRequest";
    case "MEDICATION_DISPENSE":
      return "MedicationDispense";
    case "MEDICATION_ADMINISTRATION":
      return "MedicationAdministration";
    case "PROCEDURE":
      return "Procedure";
    case "TransferEncounter":
    case "Encounter":
      return "Encounter";
    case "DischargeIPS":
      return "Bundle";
    case "ImagingOrder":
      return "ServiceRequest";
    case "ConsultationEncounter":
      return "Encounter";
    case "ConsultationObservation":
      return "Observation";
    default:
      return resourceType;
  }
}

async function publishConsultationEvent(
  event: OutboxEventRecord,
  mappingEvent: OutboxEventRecord,
  tenantEnvironment: HieEnvironment
) {
  const mapped = await buildConsultationResource(mappingEvent);
  const startedAt = Date.now();
  const response = await postWithRetryVerification({
    eventAttemptCount: event.attemptCount,
    postPath: mapped.postPath,
    resourceType: mapped.resourceType,
    resourceId: mapped.resource.id,
    body: mapped.resource,
    correlationId: event.correlationId,
    tenantEnvironment,
  });
  await completeClinicalEvent({
    event,
    localResourceType: mapped.localResourceType,
    localResourceId: mapped.localResourceId,
    hieResourceType: mapped.resourceType,
    hieResourceId: mapped.resource.id,
    httpStatus: response.status,
    startedAt,
  });
}

async function publishDeferredClinicalEvent(
  event: OutboxEventRecord,
  mappingEvent: OutboxEventRecord,
  remoteResourceType: string,
  tenantEnvironment: HieEnvironment
) {
  const payload = deferredClinicalPayloadSchema.parse(
    decryptHieJson(event.payloadEncrypted)
  );
  if (event.operation === "DELETE") {
    if (!payload.hieResourceIdEncrypted) {
      throw new HieDependencyError(
        "NATIONAL_RESOURCE_ID_REQUIRED",
        "A synchronized national resource is required for correction"
      );
    }
    let status = 204;
    try {
      const response = await rhieRequest({
        service: "SHR",
        method: "DELETE",
        path: `${remoteResourceType}/${decryptHieValue(payload.hieResourceIdEncrypted)}`,
        correlationId: event.correlationId,
        tenantEnvironment,
      });
      status = response.status;
    } catch (error) {
      if (!(error instanceof RhieRequestError && error.status === 404)) {
        throw error;
      }
      status = 404;
    }
    await db.$transaction([
      db.hieSyncAttempt.create({
        data: {
          eventId: event.id,
          attemptNumber: event.attemptCount + 1,
          httpStatus: status,
          outcome: "SUCCEEDED",
        },
      }),
      db.hieOutboxEvent.update({
        where: { id: event.id },
        data: {
          status: "SUCCEEDED",
          attemptCount: { increment: 1 },
          completedAt: new Date(),
          lockedAt: null,
        },
      }),
    ]);
    return;
  }
  const mapped = await buildDeferredClinicalResource(mappingEvent);
  const startedAt = Date.now();
  const response = await postWithRetryVerification({
    eventAttemptCount: event.attemptCount,
    postPath: mapped.postPath,
    resourceType: mapped.resourceType,
    resourceId: mapped.resource.id,
    body: mapped.resource,
    correlationId: event.correlationId,
    tenantEnvironment,
  });
  await completeClinicalEvent({
    event,
    localResourceType: mapped.localResourceType,
    localResourceId: mapped.localResourceId,
    hieResourceType: mapped.resourceType,
    hieResourceId: mapped.resource.id,
    httpStatus: response.status,
    startedAt,
  });
}

async function publishConsentEvent(
  event: OutboxEventRecord,
  resourceId: string,
  tenantEnvironment: HieEnvironment
) {
  const payload = consentPayloadSchema.parse(
    decryptHieJson(event.payloadEncrypted)
  );
  const consent = await db.hieConsent.findFirst({
    where: { id: payload.consentId, clinicId: event.clinicId },
  });
  if (!consent) {
    throw new HieDependencyError(
      "CONSENT_NOT_FOUND",
      "The local consent no longer exists"
    );
  }
  const startedAt = Date.now();
  if (event.operation === "DELETE") {
    const encryptedId =
      payload.hieResourceIdEncrypted ?? consent.hieResourceIdEncrypted;
    if (!encryptedId) {
      throw new HieDependencyError(
        "NATIONAL_CONSENT_ID_REQUIRED",
        "National consent synchronization must complete before withdrawal"
      );
    }
    let status = 204;
    try {
      const response = await rhieRequest({
        service: "SHR",
        method: "DELETE",
        path: `Consent/${decryptHieValue(encryptedId)}`,
        correlationId: event.correlationId,
        tenantEnvironment,
      });
      status = response.status;
    } catch (error) {
      if (!(error instanceof RhieRequestError && error.status === 404)) {
        throw error;
      }
    }
    await db.$transaction([
      db.hieConsent.update({
        where: { id: consent.id },
        data: {
          syncStatus: "WITHDRAWN",
          synchronizedAt: new Date(),
          lastSyncAttemptAt: new Date(),
          lastSyncFailureCode: null,
          lastSyncFailureMessage: null,
        },
      }),
      db.hieSyncAttempt.create({
        data: {
          eventId: event.id,
          attemptNumber: event.attemptCount + 1,
          httpStatus: status,
          outcome: "SUCCEEDED",
          durationMs: Date.now() - startedAt,
        },
      }),
      db.hieOutboxEvent.update({
        where: { id: event.id },
        data: {
          status: "SUCCEEDED",
          attemptCount: { increment: 1 },
          completedAt: new Date(),
          lockedAt: null,
        },
      }),
    ]);
    return;
  }
  const identity = await db.patientExternalIdentity.findFirst({
    where: {
      patientId: payload.patientId,
      verificationStatus: "VERIFIED",
      resourceIdEncrypted: { not: null },
    },
  });
  if (!identity?.resourceIdEncrypted) {
    throw new HieDependencyError(
      "PATIENT_IDENTITY_REQUIRED",
      "Verified Client Registry identity is required"
    );
  }
  const resource = mapHieConsent({
    id: resourceId,
    patientReference: decryptHieValue(identity.resourceIdEncrypted),
    scope: payload.scope,
    purpose: payload.purpose,
    recordedAt: new Date(payload.recordedAt),
  });
  const response = await postWithRetryVerification({
    eventAttemptCount: event.attemptCount,
    postPath: "Consent",
    resourceType: "Consent",
    resourceId,
    body: resource,
    correlationId: event.correlationId,
    tenantEnvironment,
  });
  await db.$transaction([
    db.hieConsent.update({
      where: { id: consent.id },
      data: {
        syncStatus: "SYNCED",
        hieResourceIdEncrypted: encryptHieValue(resourceId),
        synchronizedAt: new Date(),
        lastSyncAttemptAt: new Date(),
        lastSyncFailureCode: null,
        lastSyncFailureMessage: null,
      },
    }),
    db.hieSyncAttempt.create({
      data: {
        eventId: event.id,
        attemptNumber: event.attemptCount + 1,
        httpStatus: response.status,
        outcome: "SUCCEEDED",
        durationMs: Date.now() - startedAt,
      },
    }),
    db.hieOutboxEvent.update({
      where: { id: event.id },
      data: {
        status: "SUCCEEDED",
        attemptCount: { increment: 1 },
        completedAt: new Date(),
        lockedAt: null,
      },
    }),
  ]);
  await db.$transaction((tx) =>
    resumeBlockedPatientEvents(tx, {
      clinicId: event.clinicId,
      patientId: consent.patientId,
    })
  );
}

async function publishDischargeIpsEvent(
  event: OutboxEventRecord,
  mappingEvent: OutboxEventRecord,
  tenantEnvironment: HieEnvironment
) {
  const { payload: dischargePayload, resource: dischargeResource } =
    await buildDischargeIps(mappingEvent);
  const startedAt = Date.now();
  const response = await postWithRetryVerification({
    eventAttemptCount: event.attemptCount,
    postPath: "Bundle/$submit-ips",
    resourceType: "Bundle",
    resourceId: dischargeResource.id,
    body: dischargeResource,
    correlationId: event.correlationId,
    tenantEnvironment,
  });
  await completeClinicalEvent({
    event,
    localResourceType: "Hospitalization",
    localResourceId: String(dischargePayload.hospitalizationId),
    hieResourceType: "Bundle",
    hieResourceId: dischargeResource.id,
    httpStatus: response.status,
    startedAt,
  });
}

async function publishClinicalSnapshotEvent(
  event: OutboxEventRecord,
  mappingEvent: OutboxEventRecord,
  tenantEnvironment: HieEnvironment
) {
  const mapped = await buildClinicalResource(mappingEvent);
  const startedAt = Date.now();
  const response = await postWithRetryVerification({
    eventAttemptCount: event.attemptCount,
    postPath: mapped.postPath,
    resourceType: mapped.resourceType,
    resourceId: mapped.resource.id,
    body: mapped.resource,
    correlationId: event.correlationId,
    tenantEnvironment,
  });
  await completeClinicalEvent({
    event,
    localResourceType: mapped.payload.localResourceType,
    localResourceId: mapped.payload.localResourceId,
    hieResourceType: mapped.resourceType,
    hieResourceId: mapped.resource.id,
    httpStatus: response.status,
    startedAt,
  });
}

async function publishTransferEncounterEvent(
  event: OutboxEventRecord,
  mappingEvent: OutboxEventRecord,
  tenantEnvironment: HieEnvironment
) {
  const { transfer, resource: transferResource } =
    await buildTransferEncounter(mappingEvent);
  const startedAt = Date.now();
  const response = await postWithRetryVerification({
    eventAttemptCount: event.attemptCount,
    postPath: "Encounter/transfer",
    resourceType: "Encounter",
    resourceId: transferResource.id,
    body: transferResource,
    correlationId: event.correlationId,
    tenantEnvironment,
  });
  await completeClinicalEvent({
    event,
    localResourceType: "HieExternalTransfer",
    localResourceId: String(transfer.id),
    hieResourceType: "Encounter",
    hieResourceId: transferResource.id,
    httpStatus: response.status,
    startedAt,
  });
}

async function publishTransferIpsEvent(
  event: OutboxEventRecord,
  mappingEvent: OutboxEventRecord,
  environment: HieEnvironment
) {
  const {
    transfer,
    clinicalSummary,
    authoredAt,
    resource: transferResource,
    patientReference,
    practitionerReference,
  } = await buildTransferEncounter(mappingEvent);
  const encounterLink = await db.hieResourceLink.findUnique({
    where: {
      clinicId_localResourceType_localResourceId_hieResourceType: {
        clinicId: event.clinicId,
        localResourceType: "HieExternalTransfer",
        localResourceId: String(transfer.id),
        hieResourceType: "Encounter",
      },
    },
    select: { id: true },
  });
  if (!encounterLink) {
    throw new HieDependencyError(
      "TRANSFER_ENCOUNTER_REQUIRED",
      "The transfer Encounter must be synchronized before its IPS"
    );
  }
  const summary = mapTransferIpsBundle({
    id: deterministicHieResourceId({
      environment,
      clinicId: event.clinicId,
      localResourceType: event.aggregateType,
      localResourceId: event.aggregateId,
      hieResourceType: "Bundle",
    }),
    patientReference,
    practitionerReference,
    clinicalSummary,
    encounter: transferResource,
    authoredAt,
  });
  const startedAt = Date.now();
  const response = await postWithRetryVerification({
    eventAttemptCount: event.attemptCount,
    postPath: "Bundle/$submit-ips",
    resourceType: "Bundle",
    resourceId: summary.id,
    body: summary,
    correlationId: event.correlationId,
    tenantEnvironment: environment,
  });
  await db.$transaction(async (tx) => {
    await tx.hieResourceLink.upsert({
      where: {
        clinicId_localResourceType_localResourceId_hieResourceType: {
          clinicId: event.clinicId,
          localResourceType: "HieExternalTransfer",
          localResourceId: String(transfer.id),
          hieResourceType: "Bundle",
        },
      },
      create: {
        clinicId: event.clinicId,
        localResourceType: "HieExternalTransfer",
        localResourceId: String(transfer.id),
        hieResourceType: "Bundle",
        hieResourceIdHash: hashHieIdentifier(summary.id),
        hieResourceIdEncrypted: encryptHieValue(summary.id),
        lastSyncedAt: new Date(),
      },
      update: { lastSyncedAt: new Date() },
    });
    await tx.hieExternalTransfer.update({
      where: { id: transfer.id },
      data: {
        status: "SENT",
        sentAt: new Date(),
        hieEncounterIdEncrypted: encryptHieValue(transferResource.id),
      },
    });
    await tx.hieSyncAttempt.create({
      data: {
        eventId: event.id,
        attemptNumber: event.attemptCount + 1,
        httpStatus: response.status,
        outcome: "SUCCEEDED",
        durationMs: Date.now() - startedAt,
      },
    });
    await tx.hieOutboxEvent.update({
      where: { id: event.id },
      data: {
        status: "SUCCEEDED",
        attemptCount: { increment: 1 },
        completedAt: new Date(),
        lockedAt: null,
      },
    });
  });
}

async function publishTriageObservationEvent(
  event: OutboxEventRecord,
  mappingEvent: OutboxEventRecord,
  tenantEnvironment: HieEnvironment
) {
  const { localResourceId, resource: observationResource } =
    await buildVitalObservation(mappingEvent);
  const startedAt = Date.now();
  const response = await postWithRetryVerification({
    eventAttemptCount: event.attemptCount,
    postPath: "Observation/vital-signs",
    resourceType: "Observation",
    resourceId: observationResource.id,
    body: observationResource,
    correlationId: event.correlationId,
    tenantEnvironment,
  });
  await db.$transaction(async (tx) => {
    await tx.hieResourceLink.upsert({
      where: {
        clinicId_localResourceType_localResourceId_hieResourceType: {
          clinicId: event.clinicId,
          localResourceType: "Triage",
          localResourceId,
          hieResourceType: "Observation",
        },
      },
      create: {
        clinicId: event.clinicId,
        localResourceType: "Triage",
        localResourceId,
        hieResourceType: "Observation",
        hieResourceIdHash: hashHieIdentifier(observationResource.id),
        hieResourceIdEncrypted: encryptHieValue(observationResource.id),
        lastSyncedAt: new Date(),
      },
      update: { lastSyncedAt: new Date() },
    });
    await tx.hieSyncAttempt.create({
      data: {
        eventId: event.id,
        attemptNumber: event.attemptCount + 1,
        httpStatus: response.status,
        outcome: "SUCCEEDED",
        durationMs: Date.now() - startedAt,
      },
    });
    await tx.hieOutboxEvent.update({
      where: { id: event.id },
      data: {
        status: "SUCCEEDED",
        attemptCount: { increment: 1 },
        completedAt: new Date(),
        lockedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
  });
}

async function publishVisitConditionEvent(
  event: OutboxEventRecord,
  mappingEvent: OutboxEventRecord,
  tenantEnvironment: HieEnvironment
) {
  const { diagnosisId, resource: conditionResource } =
    await buildVisitCondition(mappingEvent);
  const startedAt = Date.now();
  const response = await postWithRetryVerification({
    eventAttemptCount: event.attemptCount,
    postPath: "Condition",
    resourceType: "Condition",
    resourceId: conditionResource.id,
    body: conditionResource,
    correlationId: event.correlationId,
    tenantEnvironment,
  });
  await db.$transaction(async (tx) => {
    await tx.hieResourceLink.upsert({
      where: {
        clinicId_localResourceType_localResourceId_hieResourceType: {
          clinicId: event.clinicId,
          localResourceType: "VisitDiagnosis",
          localResourceId: String(diagnosisId),
          hieResourceType: "Condition",
        },
      },
      create: {
        clinicId: event.clinicId,
        localResourceType: "VisitDiagnosis",
        localResourceId: String(diagnosisId),
        hieResourceType: "Condition",
        hieResourceIdHash: hashHieIdentifier(conditionResource.id),
        hieResourceIdEncrypted: encryptHieValue(conditionResource.id),
        lastSyncedAt: new Date(),
      },
      update: { lastSyncedAt: new Date() },
    });
    await tx.hieSyncAttempt.create({
      data: {
        eventId: event.id,
        attemptNumber: event.attemptCount + 1,
        httpStatus: response.status,
        outcome: "SUCCEEDED",
        durationMs: Date.now() - startedAt,
      },
    });
    await tx.hieOutboxEvent.update({
      where: { id: event.id },
      data: {
        status: "SUCCEEDED",
        attemptCount: { increment: 1 },
        completedAt: new Date(),
        lockedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
  });
}

async function publishVisitEncounterEvent(
  event: OutboxEventRecord,
  mappingEvent: OutboxEventRecord,
  tenantEnvironment: HieEnvironment
) {
  const resource = await buildVisitEncounter(mappingEvent);
  const startedAt = Date.now();
  const response = await postWithRetryVerification({
    eventAttemptCount: event.attemptCount,
    postPath: "Encounter",
    resourceType: "Encounter",
    resourceId: resource.id,
    body: resource,
    correlationId: event.correlationId,
    tenantEnvironment,
  });
  const payload = visitPayloadSchema.parse(
    decryptHieJson(event.payloadEncrypted)
  );
  await db.$transaction(async (tx) => {
    await tx.hieResourceLink.upsert({
      where: {
        clinicId_localResourceType_localResourceId_hieResourceType: {
          clinicId: event.clinicId,
          localResourceType: "Visit",
          localResourceId: String(payload.visitId),
          hieResourceType: "Encounter",
        },
      },
      create: {
        clinicId: event.clinicId,
        localResourceType: "Visit",
        localResourceId: String(payload.visitId),
        hieResourceType: "Encounter",
        hieResourceIdHash: hashHieIdentifier(resource.id),
        hieResourceIdEncrypted: encryptHieValue(resource.id),
        lastSyncedAt: new Date(),
      },
      update: { lastSyncedAt: new Date() },
    });
    await tx.hieSyncAttempt.create({
      data: {
        eventId: event.id,
        attemptNumber: event.attemptCount + 1,
        httpStatus: response.status,
        outcome: "SUCCEEDED",
        durationMs: Date.now() - startedAt,
      },
    });
    await tx.hieOutboxEvent.update({
      where: { id: event.id },
      data: {
        status: "SUCCEEDED",
        attemptCount: { increment: 1 },
        completedAt: new Date(),
        lockedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    await tx.hieOutboxEvent.updateMany({
      where: {
        clinicId: event.clinicId,
        status: "BLOCKED",
        lastErrorCode: {
          in: ["PARENT_ENCOUNTER_REQUIRED", "TRANSFER_ENCOUNTER_REQUIRED"],
        },
      },
      data: {
        status: "PENDING",
        dependencyReason: null,
        nextAttemptAt: new Date(),
        lockedAt: null,
      },
    });
  });
}

async function processEvent(event: OutboxEventRecord) {
  const config = await db.hieTenantConfig.findUnique({
    where: { clinicId: event.clinicId },
    select: {
      environment: true,
      enabled: true,
      sharedRecordWriteEnabled: true,
      transferEnabled: true,
      consentSyncEnabled: true,
      consultationWriteEnabled: true,
      allergyWriteEnabled: true,
      immunizationWriteEnabled: true,
      imagingWriteEnabled: true,
    },
  });
  if (!(config && publicationCapabilityEnabled(config, event.resourceType))) {
    throw new HieDependencyError(
      "HIE_CAPABILITY_DISABLED",
      "The HIE publication capability is disabled"
    );
  }
  const remoteResourceType = remoteHieResourceType(event.resourceType);
  const resourceId = deterministicHieResourceId({
    environment: config.environment,
    clinicId: event.clinicId,
    localResourceType: event.aggregateType,
    localResourceId: event.aggregateId,
    hieResourceType: remoteResourceType,
  });
  const mappingEvent = { ...event, id: resourceId };

  if (CONSULTATION_RESOURCE_TYPES.includes(event.resourceType)) {
    return await publishConsultationEvent(
      event,
      mappingEvent,
      config.environment
    );
  }
  if (DEFERRED_CLINICAL_RESOURCE_TYPES.includes(event.resourceType)) {
    return await publishDeferredClinicalEvent(
      event,
      mappingEvent,
      remoteResourceType,
      config.environment
    );
  }
  if (event.resourceType === "Consent") {
    return await publishConsentEvent(event, resourceId, config.environment);
  }
  if (event.resourceType === "DischargeIPS") {
    return await publishDischargeIpsEvent(
      event,
      mappingEvent,
      config.environment
    );
  }
  if (CLINICAL_SNAPSHOT_RESOURCE_TYPES.has(event.resourceType)) {
    return await publishClinicalSnapshotEvent(
      event,
      mappingEvent,
      config.environment
    );
  }
  if (event.resourceType === "TransferEncounter") {
    return await publishTransferEncounterEvent(
      event,
      mappingEvent,
      config.environment
    );
  }
  if (event.resourceType === "TransferIPS") {
    return await publishTransferIpsEvent(
      event,
      mappingEvent,
      config.environment
    );
  }
  if (event.resourceType === "Observation") {
    return await publishTriageObservationEvent(
      event,
      mappingEvent,
      config.environment
    );
  }
  if (event.resourceType === "Condition") {
    return await publishVisitConditionEvent(
      event,
      mappingEvent,
      config.environment
    );
  }
  if (event.resourceType !== "Encounter") {
    throw new HieDependencyError(
      "RESOURCE_NOT_IMPLEMENTED",
      `Unsupported outbox resource ${event.resourceType}`
    );
  }
  return await publishVisitEncounterEvent(
    event,
    mappingEvent,
    config.environment
  );
}

type PublicationFailureStatus = "BLOCKED" | "RETRY" | "DEAD_LETTER";

function classifyPublicationFailure(params: {
  attemptNumber: number;
  error: unknown;
}) {
  const { error } = params;
  const dependency = error instanceof HieDependencyError;
  const requestError = error instanceof RhieRequestError ? error : null;
  const exhausted = params.attemptNumber >= MAX_ATTEMPTS;
  let status: PublicationFailureStatus = "DEAD_LETTER";
  if (dependency) {
    status = "BLOCKED";
  } else if (requestError?.retryable && !exhausted) {
    status = "RETRY";
  }
  const code = dependency
    ? error.code
    : (requestError?.code ?? "HIE_PUBLICATION_FAILED");
  let message = "HIE publication failed";
  if (dependency) {
    message = error.message;
  } else if (requestError) {
    message = requestError.message;
  }
  return { dependency, requestError, status, code, message };
}

async function recordTransferPublicationFailure(params: {
  payloadEncrypted: string;
  status: PublicationFailureStatus;
  message: string;
}) {
  const payload = transferPayloadSchema.safeParse(
    decryptHieJson(params.payloadEncrypted)
  );
  if (!payload.success) {
    return;
  }
  await db.hieExternalTransfer.updateMany({
    where: { id: payload.data.transferId, status: "QUEUED" },
    data: {
      status: params.status === "RETRY" ? "QUEUED" : "FAILED",
      acknowledgement: params.message,
    },
  });
}

async function recordConsentPublicationFailure(params: {
  payloadEncrypted: string;
  operation: string;
  code: string;
  message: string;
}) {
  const payload = consentPayloadSchema.safeParse(
    decryptHieJson(params.payloadEncrypted)
  );
  if (!payload.success) {
    return;
  }
  await db.hieConsent.updateMany({
    where: { id: payload.data.consentId },
    data: {
      syncStatus:
        params.operation === "DELETE" ? "WITHDRAWAL_PENDING" : "FAILED",
      lastSyncAttemptAt: new Date(),
      lastSyncFailureCode: params.code,
      lastSyncFailureMessage: params.message,
    },
  });
}

async function recordFailure(
  event: {
    id: string;
    attemptCount: number;
    resourceType: string;
    operation: string;
    payloadEncrypted: string;
  },
  error: unknown
) {
  const attemptNumber = event.attemptCount + 1;
  const { dependency, requestError, status, code, message } =
    classifyPublicationFailure({ attemptNumber, error });
  const delay =
    RETRY_DELAYS_MS[Math.min(attemptNumber - 1, RETRY_DELAYS_MS.length - 1)];
  await db.$transaction([
    db.hieSyncAttempt.create({
      data: {
        eventId: event.id,
        attemptNumber,
        httpStatus: requestError?.status,
        outcome: status,
        errorCode: code,
        errorMessage: message,
      },
    }),
    db.hieOutboxEvent.update({
      where: { id: event.id },
      data: {
        status,
        dependencyReason: dependency ? message : null,
        attemptCount: { increment: 1 },
        nextAttemptAt: new Date(Date.now() + delay),
        lockedAt: null,
        lastErrorCode: code,
        lastErrorMessage: message,
      },
    }),
  ]);
  if (["TransferEncounter", "TransferIPS"].includes(event.resourceType)) {
    await recordTransferPublicationFailure({
      payloadEncrypted: event.payloadEncrypted,
      status,
      message,
    });
  }
  if (event.resourceType === "Consent") {
    await recordConsentPublicationFailure({
      payloadEncrypted: event.payloadEncrypted,
      operation: event.operation,
      code,
      message,
    });
  }
}

export async function processHieOutbox(limit = 20) {
  await resumeBlockedHieDependencies();
  await db.hieOutboxEvent.updateMany({
    where: {
      status: "PROCESSING",
      lockedAt: { lt: new Date(Date.now() - 15 * 60_000) },
    },
    data: {
      status: "RETRY",
      lockedAt: null,
      nextAttemptAt: new Date(),
      attemptCount: { increment: 1 },
      lastErrorCode: "WORKER_LEASE_EXPIRED",
      lastErrorMessage: "Publication worker lease expired before completion",
    },
  });
  const candidates = await db.hieOutboxEvent.findMany({
    where: {
      status: { in: ["PENDING", "RETRY"] },
      nextAttemptAt: { lte: new Date() },
    },
    orderBy: [{ dependencyOrder: "asc" }, { createdAt: "asc" }],
    take: limit,
  });
  let processed = 0;
  for (const candidate of candidates) {
    const claimed = await db.hieOutboxEvent.updateMany({
      where: {
        id: candidate.id,
        status: { in: ["PENDING", "RETRY"] },
        lockedAt: null,
      },
      data: { status: "PROCESSING", lockedAt: new Date() },
    });
    if (claimed.count !== 1) {
      continue;
    }
    try {
      await processEvent(candidate);
    } catch (error) {
      await recordFailure(candidate, error);
    }
    processed += 1;
  }
  if (processed > 0) {
    logger.info("hie.outbox.cycle_completed", { processed });
  }
  return processed;
}

export function resumeBlockedHieDependencies(
  client: PrismaClient = db,
  now = new Date()
) {
  return client.hieOutboxEvent.updateMany({
    where: {
      status: "BLOCKED",
      nextAttemptAt: { lte: now },
      attemptCount: { lt: MAX_ATTEMPTS },
    },
    data: {
      status: "PENDING",
      dependencyReason: null,
      lockedAt: null,
    },
  });
}

export function retryHieEvent(params: { clinicId: number; eventId: string }) {
  return db.hieOutboxEvent.updateMany({
    where: {
      id: params.eventId,
      clinicId: params.clinicId,
      status: { in: ["BLOCKED", "DEAD_LETTER", "RETRY"] },
    },
    data: {
      status: "PENDING",
      dependencyReason: null,
      nextAttemptAt: new Date(),
      lockedAt: null,
    },
  });
}
