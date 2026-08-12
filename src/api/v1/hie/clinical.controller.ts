import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import type { z } from "zod";
import { db } from "@/database/db";
import { jsonSuccess } from "@/lib/api-response";
import { AppError, notFoundError } from "@/lib/app-error";
import type { AppEnv } from "@/middlewares/auth.middleware";
import { encryptHieJson } from "@/services/hie/hie-crypto.service";
import { hieOutboxIdempotencyKey } from "@/services/hie/hie-resource-id";
import type { Prisma } from "../../../../generated/prisma/client";
import type {
  clinicalConceptQuerySchema,
  consultationObservationSchema,
  imagingOrderSchema,
  imagingStudySchema,
  structuredAllergyCorrectionSchema,
  structuredAllergySchema,
  structuredImmunizationCorrectionSchema,
  structuredImmunizationSchema,
  structuredRecordListSchema,
} from "./clinical.validation";

type ConsultationObservationInput = z.infer<
  typeof consultationObservationSchema
>;
type ClinicalConceptQuery = z.infer<typeof clinicalConceptQuerySchema>;

type AllergyInput = z.infer<typeof structuredAllergySchema>;
type AllergyCorrectionInput = z.infer<typeof structuredAllergyCorrectionSchema>;
type ImmunizationInput = z.infer<typeof structuredImmunizationSchema>;
type ImmunizationCorrectionInput = z.infer<
  typeof structuredImmunizationCorrectionSchema
>;
type ImagingOrderInput = z.infer<typeof imagingOrderSchema>;
type ImagingStudyInput = z.infer<typeof imagingStudySchema>;
type ListQuery = z.infer<typeof structuredRecordListSchema>;

function tenant(c: Context<AppEnv>) {
  const clinicId = c.get("clinicId");
  const user = c.get("user");
  if (!(clinicId && user)) {
    throw new AppError({
      status: 403,
      code: "HIE_TENANT_REQUIRED",
      message: "A clinic context is required",
    });
  }
  return { clinicId, actorId: Number(user.id) };
}

async function assertPatient(clinicId: number, patientId: number) {
  const patient = await db.patient.findFirst({
    where: { id: patientId, clinics: { some: { id: clinicId } } },
    select: { id: true },
  });
  if (!patient) {
    throw notFoundError("Patient not found");
  }
}

async function assertClinicalReferences(params: {
  clinicId: number;
  branchId: number;
  practitionerId: number;
  visitId?: number | null;
}) {
  const [branch, practitioner, visit] = await Promise.all([
    db.branch.findFirst({
      where: { id: params.branchId, clinicId: params.clinicId },
      select: { id: true },
    }),
    db.user.findFirst({
      where: { id: params.practitionerId, clinicId: params.clinicId },
      select: { id: true },
    }),
    params.visitId
      ? db.visit.findFirst({
          where: { id: params.visitId, clinicId: params.clinicId },
          select: { id: true },
        })
      : Promise.resolve({ id: 0 }),
  ]);
  if (!(branch && practitioner && visit)) {
    throw new AppError({
      status: 400,
      code: "HIE_CLINICAL_REFERENCE_INVALID",
      message: "Branch, practitioner, or visit is outside this clinic",
      exposeMessage: true,
    });
  }
}

async function verifiedConcept(params: {
  conceptId: number;
  domain:
    | "ALLERGY"
    | "VACCINE"
    | "IMAGING_PROCEDURE"
    | "CONSULTATION_OBSERVATION"
    | "IMAGING_REASON"
    | "BODY_SITE";
}) {
  const concept = await db.hieClinicalConcept.findFirst({
    where: {
      id: params.conceptId,
      domain: params.domain,
      status: "VERIFIED",
      active: true,
    },
  });
  if (!concept) {
    throw new AppError({
      status: 409,
      code: "HIE_VERIFIED_CONCEPT_REQUIRED",
      message: "A verified active national clinical concept is required",
      exposeMessage: true,
    });
  }
  return concept;
}

async function clinicalAudit(params: {
  clinicId: number;
  actorId: number;
  patientId?: number;
  action: string;
  outcome?: string;
  metadata?: Prisma.InputJsonValue;
}) {
  await db.hieAuditEvent.create({
    data: {
      clinicId: params.clinicId,
      actorId: params.actorId,
      patientId: params.patientId,
      action: params.action,
      capability: "STRUCTURED_CLINICAL_RECORD",
      purposeOfUse: "TREATMENT",
      outcome: params.outcome ?? "SUCCESS",
      correlationId: randomUUID(),
      metadata: params.metadata,
    },
  });
}

async function enqueueFinalizedRecord(params: {
  clinicId: number;
  capability:
    | "allergyWriteEnabled"
    | "immunizationWriteEnabled"
    | "imagingWriteEnabled"
    | "consultationWriteEnabled";
  aggregateType: string;
  aggregateId: string;
  resourceType: string;
  operation?: "CREATE" | "DELETE";
  payload: Record<string, unknown>;
  dependencyOrder: number;
}) {
  const config = await db.hieTenantConfig.findUnique({
    where: { clinicId: params.clinicId },
  });
  if (!(config?.enabled && config[params.capability])) {
    return null;
  }
  const operation = params.operation ?? "CREATE";
  return db.hieOutboxEvent.upsert({
    where: {
      idempotencyKey: hieOutboxIdempotencyKey({
        environment: config.environment,
        clinicId: params.clinicId,
        localResourceType: params.aggregateType,
        localResourceId: params.aggregateId,
        hieResourceType: params.resourceType,
        operation,
      }),
    },
    create: {
      clinicId: params.clinicId,
      aggregateType: params.aggregateType,
      aggregateId: params.aggregateId,
      resourceType: params.resourceType,
      operation,
      dependencyOrder: params.dependencyOrder,
      payloadEncrypted: encryptHieJson(params.payload),
      idempotencyKey: hieOutboxIdempotencyKey({
        environment: config.environment,
        clinicId: params.clinicId,
        localResourceType: params.aggregateType,
        localResourceId: params.aggregateId,
        hieResourceType: params.resourceType,
        operation,
      }),
      correlationId: randomUUID(),
    },
    update: {},
  });
}

export async function listVerifiedClinicalConcepts(c: Context<AppEnv>) {
  tenant(c);
  const query = c.get("validatedQuery") as ClinicalConceptQuery;
  const concepts = await db.hieClinicalConcept.findMany({
    where: {
      domain: query.domain,
      status: "VERIFIED",
      active: true,
      ...(query.search
        ? {
            OR: [
              { code: { contains: query.search, mode: "insensitive" } },
              { display: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      domain: true,
      codingSystem: true,
      code: true,
      display: true,
    },
    orderBy: [{ display: "asc" }, { code: "asc" }],
    take: 100,
  });
  return jsonSuccess(c, { data: concepts });
}

export async function listConsultationObservations(c: Context<AppEnv>) {
  const { clinicId } = tenant(c);
  const patientId = Number(c.req.param("patientId"));
  const query = c.get("validatedQuery") as ListQuery;
  await assertPatient(clinicId, patientId);
  const where = { clinicId, patientId, status: query.status };
  const [items, totalCount] = await Promise.all([
    db.hieConsultationObservation.findMany({
      where,
      include: { concept: true },
      orderBy: { clinicalAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page,
    }),
    db.hieConsultationObservation.count({ where }),
  ]);
  return jsonSuccess(c, {
    data: items,
    meta: {
      page: query.page,
      perPage: query.per_page,
      totalCount,
      pageCount: Math.ceil(totalCount / query.per_page),
    },
  });
}

export async function createConsultationObservation(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const patientId = Number(c.req.param("patientId"));
  const input = c.get("validatedJson") as ConsultationObservationInput;
  await Promise.all([
    assertPatient(clinicId, patientId),
    verifiedConcept({
      conceptId: input.conceptId,
      domain: "CONSULTATION_OBSERVATION",
    }),
    assertClinicalReferences({
      clinicId,
      branchId: input.branchId,
      practitionerId: input.practitionerId,
      visitId: input.visitId,
    }),
  ]);
  const observation = await db.hieConsultationObservation.create({
    data: {
      clinicId,
      patientId,
      ...input,
      clinicalAt: new Date(input.clinicalAt),
    },
    include: { concept: true },
  });
  await clinicalAudit({
    clinicId,
    actorId,
    patientId,
    action: "consultation-observation.created",
    metadata: { observationId: observation.id },
  });
  return jsonSuccess(c, { status: 201, data: observation });
}

export async function finalizeConsultationObservation(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const id = Number(c.req.param("id"));
  const observation = await db.hieConsultationObservation.findFirst({
    where: { id, clinicId, status: "DRAFT" },
  });
  if (!observation) {
    throw notFoundError("Draft consultation observation not found");
  }
  const finalized = await db.hieConsultationObservation.update({
    where: { id },
    data: { status: "FINAL", finalizedAt: new Date() },
  });
  await enqueueFinalizedRecord({
    clinicId,
    capability: "consultationWriteEnabled",
    aggregateType: "HieConsultationObservation",
    aggregateId: String(id),
    resourceType: "ConsultationObservation",
    payload: { localId: id },
    dependencyOrder: 25,
  });
  await clinicalAudit({
    clinicId,
    actorId,
    patientId: observation.patientId,
    action: "consultation-observation.finalized",
    metadata: { observationId: id },
  });
  return jsonSuccess(c, { data: finalized });
}

export async function listStructuredAllergies(c: Context<AppEnv>) {
  const { clinicId } = tenant(c);
  const patientId = Number(c.req.param("patientId"));
  const query = c.get("validatedQuery") as ListQuery;
  await assertPatient(clinicId, patientId);
  const where = { clinicId, patientId, status: query.status };
  const [items, totalCount] = await Promise.all([
    db.hieStructuredAllergy.findMany({
      where,
      include: { allergen: true },
      orderBy: { recordedDate: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page,
    }),
    db.hieStructuredAllergy.count({ where }),
  ]);
  return jsonSuccess(c, {
    data: items,
    meta: {
      page: query.page,
      perPage: query.per_page,
      totalCount,
      pageCount: Math.ceil(totalCount / query.per_page),
    },
  });
}

async function allergyCreateData(params: {
  clinicId: number;
  patientId: number;
  input: AllergyInput;
  replacesAllergyId?: number;
}) {
  await Promise.all([
    verifiedConcept({
      conceptId: params.input.allergenConceptId,
      domain: "ALLERGY",
    }),
    assertClinicalReferences({
      clinicId: params.clinicId,
      branchId: params.input.branchId,
      practitionerId: params.input.asserterId,
      visitId: params.input.visitId,
    }),
  ]);
  return {
    clinicId: params.clinicId,
    patientId: params.patientId,
    ...params.input,
    onsetAt: new Date(params.input.onsetAt),
    recordedDate: new Date(`${params.input.recordedDate}T00:00:00.000Z`),
    reactions: params.input.reactions as Prisma.InputJsonValue,
    replacesAllergyId: params.replacesAllergyId,
  };
}

export async function createStructuredAllergy(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const patientId = Number(c.req.param("patientId"));
  const input = c.get("validatedJson") as AllergyInput;
  await assertPatient(clinicId, patientId);
  const allergy = await db.hieStructuredAllergy.create({
    data: await allergyCreateData({ clinicId, patientId, input }),
    include: { allergen: true },
  });
  await clinicalAudit({
    clinicId,
    actorId,
    patientId,
    action: "allergy.created",
    metadata: { allergyId: allergy.id },
  });
  return jsonSuccess(c, { status: 201, data: allergy });
}

export async function updateStructuredAllergy(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const id = Number(c.req.param("id"));
  const input = c.get("validatedJson") as AllergyInput;
  const existing = await db.hieStructuredAllergy.findFirst({
    where: { id, clinicId, status: "DRAFT" },
  });
  if (!existing) {
    throw notFoundError("Draft structured allergy not found");
  }
  const updated = await db.hieStructuredAllergy.update({
    where: { id },
    data: await allergyCreateData({
      clinicId,
      patientId: existing.patientId,
      input,
    }),
    include: { allergen: true },
  });
  await clinicalAudit({
    clinicId,
    actorId,
    patientId: existing.patientId,
    action: "allergy.updated",
    metadata: { allergyId: id },
  });
  return jsonSuccess(c, { data: updated });
}

export async function deleteStructuredAllergy(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const id = Number(c.req.param("id"));
  const existing = await db.hieStructuredAllergy.findFirst({
    where: { id, clinicId, status: "DRAFT" },
    select: { patientId: true },
  });
  if (!existing) {
    throw notFoundError("Draft structured allergy not found");
  }
  await db.hieStructuredAllergy.delete({ where: { id } });
  await clinicalAudit({
    clinicId,
    actorId,
    patientId: existing.patientId,
    action: "allergy.deleted",
    metadata: { allergyId: id },
  });
  return jsonSuccess(c, { data: { id } });
}

export async function finalizeStructuredAllergy(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const id = Number(c.req.param("id"));
  const allergy = await db.hieStructuredAllergy.findFirst({
    where: { id, clinicId, status: "DRAFT" },
  });
  if (!allergy) {
    throw notFoundError("Draft structured allergy not found");
  }
  const finalized = await db.hieStructuredAllergy.update({
    where: { id },
    data: { status: "FINAL", finalizedAt: new Date() },
  });
  await enqueueFinalizedRecord({
    clinicId,
    capability: "allergyWriteEnabled",
    aggregateType: "HieStructuredAllergy",
    aggregateId: String(id),
    resourceType: "AllergyIntolerance",
    payload: { localId: id },
    dependencyOrder: 30,
  });
  await clinicalAudit({
    clinicId,
    actorId,
    patientId: allergy.patientId,
    action: "allergy.finalized",
    metadata: { allergyId: id },
  });
  return jsonSuccess(c, { data: finalized });
}

export async function correctStructuredAllergy(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const id = Number(c.req.param("id"));
  const input = c.get("validatedJson") as AllergyCorrectionInput;
  const { note, ...allergyInput } = input;
  const existing = await db.hieStructuredAllergy.findFirst({
    where: { id, clinicId, status: "FINAL" },
  });
  if (!existing) {
    throw notFoundError("Final structured allergy not found");
  }
  const data = await allergyCreateData({
    clinicId,
    patientId: existing.patientId,
    input: allergyInput,
    replacesAllergyId: id,
  });
  const replacement = await db.$transaction(async (tx) => {
    await tx.hieStructuredAllergy.update({
      where: { id },
      data: { status: "CORRECTED" },
    });
    return tx.hieStructuredAllergy.create({ data });
  });
  const link = await db.hieResourceLink.findUnique({
    where: {
      clinicId_localResourceType_localResourceId_hieResourceType: {
        clinicId,
        localResourceType: "HieStructuredAllergy",
        localResourceId: String(id),
        hieResourceType: "AllergyIntolerance",
      },
    },
  });
  if (link) {
    await enqueueFinalizedRecord({
      clinicId,
      capability: "allergyWriteEnabled",
      aggregateType: "HieStructuredAllergy",
      aggregateId: String(id),
      resourceType: "AllergyIntolerance",
      operation: "DELETE",
      payload: {
        localId: id,
        hieResourceIdEncrypted: link.hieResourceIdEncrypted,
      },
      dependencyOrder: 29,
    });
  }
  await clinicalAudit({
    clinicId,
    actorId,
    patientId: existing.patientId,
    action: "allergy.corrected",
    metadata: { allergyId: id, replacementId: replacement.id, note },
  });
  return jsonSuccess(c, { status: 201, data: replacement });
}

export async function listStructuredImmunizations(c: Context<AppEnv>) {
  const { clinicId } = tenant(c);
  const patientId = Number(c.req.param("patientId"));
  const query = c.get("validatedQuery") as ListQuery;
  await assertPatient(clinicId, patientId);
  const where = { clinicId, patientId, status: query.status };
  const [items, totalCount] = await Promise.all([
    db.hieImmunization.findMany({
      where,
      include: { vaccine: true },
      orderBy: { occurrenceAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page,
    }),
    db.hieImmunization.count({ where }),
  ]);
  return jsonSuccess(c, {
    data: items,
    meta: {
      page: query.page,
      perPage: query.per_page,
      totalCount,
      pageCount: Math.ceil(totalCount / query.per_page),
    },
  });
}

async function immunizationCreateData(params: {
  clinicId: number;
  patientId: number;
  input: ImmunizationInput;
  replacesImmunizationId?: number;
}) {
  await Promise.all([
    verifiedConcept({
      conceptId: params.input.vaccineConceptId,
      domain: "VACCINE",
    }),
    assertClinicalReferences({
      clinicId: params.clinicId,
      branchId: params.input.branchId,
      practitionerId: params.input.performerId,
      visitId: params.input.visitId,
    }),
  ]);
  return {
    clinicId: params.clinicId,
    patientId: params.patientId,
    ...params.input,
    occurrenceAt: new Date(params.input.occurrenceAt),
    expiryDate: params.input.expiryDate
      ? new Date(`${params.input.expiryDate}T00:00:00.000Z`)
      : null,
    nextDueDate: params.input.nextDueDate
      ? new Date(`${params.input.nextDueDate}T00:00:00.000Z`)
      : null,
    replacesImmunizationId: params.replacesImmunizationId,
  };
}

export async function createStructuredImmunization(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const patientId = Number(c.req.param("patientId"));
  const input = c.get("validatedJson") as ImmunizationInput;
  await assertPatient(clinicId, patientId);
  const immunization = await db.hieImmunization.create({
    data: await immunizationCreateData({ clinicId, patientId, input }),
    include: { vaccine: true },
  });
  await clinicalAudit({
    clinicId,
    actorId,
    patientId,
    action: "immunization.created",
    metadata: { immunizationId: immunization.id },
  });
  return jsonSuccess(c, { status: 201, data: immunization });
}

export async function updateStructuredImmunization(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const id = Number(c.req.param("id"));
  const input = c.get("validatedJson") as ImmunizationInput;
  const existing = await db.hieImmunization.findFirst({
    where: { id, clinicId, status: "DRAFT" },
  });
  if (!existing) {
    throw notFoundError("Draft structured immunization not found");
  }
  const updated = await db.hieImmunization.update({
    where: { id },
    data: await immunizationCreateData({
      clinicId,
      patientId: existing.patientId,
      input,
    }),
    include: { vaccine: true },
  });
  await clinicalAudit({
    clinicId,
    actorId,
    patientId: existing.patientId,
    action: "immunization.updated",
    metadata: { immunizationId: id },
  });
  return jsonSuccess(c, { data: updated });
}

export async function deleteStructuredImmunization(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const id = Number(c.req.param("id"));
  const existing = await db.hieImmunization.findFirst({
    where: { id, clinicId, status: "DRAFT" },
    select: { patientId: true },
  });
  if (!existing) {
    throw notFoundError("Draft structured immunization not found");
  }
  await db.hieImmunization.delete({ where: { id } });
  await clinicalAudit({
    clinicId,
    actorId,
    patientId: existing.patientId,
    action: "immunization.deleted",
    metadata: { immunizationId: id },
  });
  return jsonSuccess(c, { data: { id } });
}

export async function finalizeStructuredImmunization(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const id = Number(c.req.param("id"));
  const immunization = await db.hieImmunization.findFirst({
    where: { id, clinicId, status: "DRAFT" },
  });
  if (!immunization) {
    throw notFoundError("Draft structured immunization not found");
  }
  const finalized = await db.hieImmunization.update({
    where: { id },
    data: { status: "FINAL", finalizedAt: new Date() },
  });
  await enqueueFinalizedRecord({
    clinicId,
    capability: "immunizationWriteEnabled",
    aggregateType: "HieImmunization",
    aggregateId: String(id),
    resourceType: "Immunization",
    payload: { localId: id },
    dependencyOrder: 30,
  });
  await clinicalAudit({
    clinicId,
    actorId,
    patientId: immunization.patientId,
    action: "immunization.finalized",
    metadata: { immunizationId: id },
  });
  return jsonSuccess(c, { data: finalized });
}

export async function correctStructuredImmunization(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const id = Number(c.req.param("id"));
  const input = c.get("validatedJson") as ImmunizationCorrectionInput;
  const { note, ...immunizationInput } = input;
  const existing = await db.hieImmunization.findFirst({
    where: { id, clinicId, status: "FINAL" },
  });
  if (!existing) {
    throw notFoundError("Final structured immunization not found");
  }
  const data = await immunizationCreateData({
    clinicId,
    patientId: existing.patientId,
    input: immunizationInput,
    replacesImmunizationId: id,
  });
  const replacement = await db.$transaction(async (tx) => {
    await tx.hieImmunization.update({
      where: { id },
      data: { status: "CORRECTED" },
    });
    return tx.hieImmunization.create({ data });
  });
  const link = await db.hieResourceLink.findUnique({
    where: {
      clinicId_localResourceType_localResourceId_hieResourceType: {
        clinicId,
        localResourceType: "HieImmunization",
        localResourceId: String(id),
        hieResourceType: "Immunization",
      },
    },
  });
  if (link) {
    await enqueueFinalizedRecord({
      clinicId,
      capability: "immunizationWriteEnabled",
      aggregateType: "HieImmunization",
      aggregateId: String(id),
      resourceType: "Immunization",
      operation: "DELETE",
      payload: {
        localId: id,
        hieResourceIdEncrypted: link.hieResourceIdEncrypted,
      },
      dependencyOrder: 29,
    });
  }
  await clinicalAudit({
    clinicId,
    actorId,
    patientId: existing.patientId,
    action: "immunization.corrected",
    metadata: {
      immunizationId: id,
      replacementId: replacement.id,
      note,
    },
  });
  return jsonSuccess(c, { status: 201, data: replacement });
}

export async function createImagingOrder(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const patientId = Number(c.req.param("patientId"));
  const input = c.get("validatedJson") as ImagingOrderInput;
  await Promise.all([
    assertPatient(clinicId, patientId),
    verifiedConcept({
      conceptId: input.procedureConceptId,
      domain: "IMAGING_PROCEDURE",
    }),
    verifiedConcept({
      conceptId: input.reasonConceptId,
      domain: "IMAGING_REASON",
    }),
    assertClinicalReferences({
      clinicId,
      branchId: input.branchId,
      practitionerId: input.requesterId,
      visitId: input.visitId,
    }),
  ]);
  const order = await db.hieImagingOrder.create({
    data: {
      clinicId,
      patientId,
      ...input,
      occurrenceAt: new Date(input.occurrenceAt),
    },
    include: { procedureConcept: true, reasonConcept: true },
  });
  await clinicalAudit({
    clinicId,
    actorId,
    patientId,
    action: "imaging-order.created",
    metadata: { imagingOrderId: order.id },
  });
  return jsonSuccess(c, { status: 201, data: order });
}

export async function finalizeImagingOrder(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const id = Number(c.req.param("id"));
  const order = await db.hieImagingOrder.findFirst({
    where: { id, clinicId, status: "DRAFT" },
  });
  if (!order) {
    throw notFoundError("Draft imaging order not found");
  }
  const finalized = await db.hieImagingOrder.update({
    where: { id },
    data: { status: "ACTIVE", finalizedAt: new Date() },
  });
  await enqueueFinalizedRecord({
    clinicId,
    capability: "imagingWriteEnabled",
    aggregateType: "HieImagingOrder",
    aggregateId: String(id),
    resourceType: "ImagingOrder",
    payload: { localId: id },
    dependencyOrder: 30,
  });
  await clinicalAudit({
    clinicId,
    actorId,
    patientId: order.patientId,
    action: "imaging-order.finalized",
    metadata: { imagingOrderId: id },
  });
  return jsonSuccess(c, { data: finalized });
}

export async function createImagingStudy(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const patientId = Number(c.req.param("patientId"));
  const input = c.get("validatedJson") as ImagingStudyInput;
  const bodySiteConceptIds = [
    ...new Set(
      input.series.flatMap((series) =>
        series.bodySiteConceptId ? [series.bodySiteConceptId] : []
      )
    ),
  ];
  await Promise.all([
    assertPatient(clinicId, patientId),
    verifiedConcept({
      conceptId: input.procedureConceptId,
      domain: "IMAGING_PROCEDURE",
    }),
    verifiedConcept({
      conceptId: input.reasonConceptId,
      domain: "IMAGING_REASON",
    }),
    ...bodySiteConceptIds.map((conceptId) =>
      verifiedConcept({ conceptId, domain: "BODY_SITE" })
    ),
    assertClinicalReferences({
      clinicId,
      branchId: input.branchId,
      practitionerId: input.practitionerId,
      visitId: input.visitId,
    }),
  ]);
  if (input.orderId) {
    const order = await db.hieImagingOrder.findFirst({
      where: { id: input.orderId, clinicId, patientId },
      select: { id: true },
    });
    if (!order) {
      throw new AppError({
        status: 400,
        code: "HIE_IMAGING_ORDER_INVALID",
        message: "Imaging order is outside this patient and clinic",
        exposeMessage: true,
      });
    }
  }
  const study = await db.hieImagingStudy.create({
    data: {
      clinicId,
      patientId,
      visitId: input.visitId,
      practitionerId: input.practitionerId,
      branchId: input.branchId,
      orderId: input.orderId,
      procedureConceptId: input.procedureConceptId,
      reasonConceptId: input.reasonConceptId,
      reasonCode: input.reasonCode,
      reasonDisplay: input.reasonDisplay,
      studyUid: input.studyUid,
      modality: input.modality,
      description: input.description,
      conclusion: input.conclusion,
      conclusionCode: input.conclusionCode,
      startedAt: new Date(input.startedAt),
      series: {
        create: input.series.map((series) => ({
          clinicId,
          seriesUid: series.seriesUid,
          modality: series.modality,
          bodySiteCode: series.bodySiteCode,
          bodySiteConceptId: series.bodySiteConceptId,
          description: series.description,
          startedAt: series.startedAt ? new Date(series.startedAt) : null,
          instances: {
            create: series.instances.map((instance) => ({
              clinicId,
              sopUid: instance.sopUid,
              sopClassUid: instance.sopClassUid,
              instanceNumber: instance.instanceNumber,
              title: instance.title,
            })),
          },
        })),
      },
    },
    include: {
      procedureConcept: true,
      reasonConcept: true,
      series: { include: { bodySiteConcept: true, instances: true } },
    },
  });
  await clinicalAudit({
    clinicId,
    actorId,
    patientId,
    action: "imaging-study.created",
    metadata: { imagingStudyId: study.id },
  });
  return jsonSuccess(c, { status: 201, data: study });
}

export async function finalizeImagingStudy(c: Context<AppEnv>) {
  const { clinicId, actorId } = tenant(c);
  const id = Number(c.req.param("id"));
  const study = await db.hieImagingStudy.findFirst({
    where: { id, clinicId, status: "REGISTERED" },
    include: { series: { include: { instances: true } } },
  });
  if (!study) {
    throw notFoundError("Registered imaging study not found");
  }
  if (study.series.some((series) => series.instances.length === 0)) {
    throw new AppError({
      status: 409,
      code: "HIE_IMAGING_METADATA_INCOMPLETE",
      message: "Every imaging series requires at least one instance",
      exposeMessage: true,
    });
  }
  const finalized = await db.hieImagingStudy.update({
    where: { id },
    data: { status: "AVAILABLE", finalizedAt: new Date() },
  });
  await enqueueFinalizedRecord({
    clinicId,
    capability: "imagingWriteEnabled",
    aggregateType: "HieImagingStudy",
    aggregateId: String(id),
    resourceType: "ImagingStudy",
    payload: { localId: id },
    dependencyOrder: 40,
  });
  await clinicalAudit({
    clinicId,
    actorId,
    patientId: study.patientId,
    action: "imaging-study.finalized",
    metadata: { imagingStudyId: id },
  });
  return jsonSuccess(c, { data: finalized });
}

export async function listImagingMetadata(c: Context<AppEnv>) {
  const { clinicId } = tenant(c);
  const patientId = Number(c.req.param("patientId"));
  const query = c.get("validatedQuery") as ListQuery;
  await assertPatient(clinicId, patientId);
  const [orders, studies] = await Promise.all([
    db.hieImagingOrder.findMany({
      where: { clinicId, patientId },
      include: { procedureConcept: true },
      orderBy: { occurrenceAt: "desc" },
      take: query.per_page,
      skip: (query.page - 1) * query.per_page,
    }),
    db.hieImagingStudy.findMany({
      where: { clinicId, patientId },
      include: {
        procedureConcept: true,
        series: { include: { instances: true } },
      },
      orderBy: { startedAt: "desc" },
      take: query.per_page,
      skip: (query.page - 1) * query.per_page,
    }),
  ]);
  return jsonSuccess(c, { data: { orders, studies } });
}
