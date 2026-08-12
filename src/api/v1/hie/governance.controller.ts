import type { Context } from "hono";
import { z } from "zod";
import { db } from "@/database/db";
import { jsonSuccess } from "@/lib/api-response";
import { AppError, notFoundError } from "@/lib/app-error";
import type { AppEnv } from "@/middlewares/auth.middleware";
import { fhirBundleSchema } from "@/services/hie/fhir.schemas";
import {
  decryptHieJson,
  decryptHieValue,
  encryptHieValue,
  hashHieIdentifier,
} from "@/services/hie/hie-crypto.service";
import { rhieRequest } from "@/services/hie/rhie-client";
import type {
  correctDobDiscrepancySchema,
  coverageMappingSchema,
  coverageQuerySchema,
  dobDiscrepancyQuerySchema,
  nationalAuditQuerySchema,
} from "./hie.validation";

type CoverageInput = z.infer<typeof coverageMappingSchema>;
type CoverageQuery = z.infer<typeof coverageQuerySchema>;
type NationalAuditQuery = z.infer<typeof nationalAuditQuerySchema>;
type DobQuery = z.infer<typeof dobDiscrepancyQuerySchema>;
type DobCorrection = z.infer<typeof correctDobDiscrepancySchema>;

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
  return { clinicId, actorId: Number(user.id), user };
}

async function requireCapability(
  clinicId: number,
  capability: "nationalAuditReadEnabled"
) {
  const config = await db.hieTenantConfig.findUnique({ where: { clinicId } });
  if (
    !(config?.enabled && config.sharedRecordReadEnabled && config[capability])
  ) {
    throw new AppError({
      status: 403,
      code: "HIE_CAPABILITY_DISABLED",
      message: "This HIE capability is not enabled for the clinic",
      exposeMessage: true,
    });
  }
}

function dateOnly(value: string | Date) {
  const text =
    value instanceof Date
      ? value.toISOString().slice(0, 10)
      : value.slice(0, 10);
  return new Date(`${text}T00:00:00.000Z`);
}

export async function listCoverageMappings(c: Context<AppEnv>) {
  const { clinicId } = tenant(c);
  const query = c.get("validatedQuery") as CoverageQuery;
  const where = {
    clinicId,
    verificationStatus: query.status,
    ...(query.patientId
      ? { patientInsurance: { patientId: query.patientId } }
      : {}),
  };
  const [items, totalCount] = await Promise.all([
    db.patientInsuranceExternalIdentity.findMany({
      where,
      select: {
        id: true,
        patientInsuranceId: true,
        verificationStatus: true,
        verificationSource: true,
        verificationReference: true,
        verificationActorId: true,
        verifiedAt: true,
        verificationExpiresAt: true,
        createdAt: true,
        updatedAt: true,
        patientInsurance: {
          select: {
            patientId: true,
            insuranceCompany: { select: { companyName: true } },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page,
    }),
    db.patientInsuranceExternalIdentity.count({ where }),
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

export async function upsertCoverageMapping(c: Context<AppEnv>) {
  const { clinicId, actorId, user } = tenant(c);
  if (user.role !== "CLINIC_ADMIN") {
    throw new AppError({
      status: 403,
      code: "HIE_COVERAGE_ADMIN_REQUIRED",
      message: "Only a clinic administrator can manage Coverage mappings",
    });
  }
  const input = c.get("validatedJson") as CoverageInput;
  const insurance = await db.patientInsurance.findFirst({
    where: {
      id: input.patientInsuranceId,
      patient: { clinics: { some: { id: clinicId } } },
    },
    select: { id: true },
  });
  if (!insurance) {
    throw notFoundError("Patient insurance not found");
  }
  const mapping = await db.patientInsuranceExternalIdentity.upsert({
    where: {
      clinicId_patientInsuranceId: {
        clinicId,
        patientInsuranceId: input.patientInsuranceId,
      },
    },
    create: {
      clinicId,
      patientInsuranceId: input.patientInsuranceId,
      coverageReferenceHash: hashHieIdentifier(input.coverageReference),
      coverageReferenceEncrypted: encryptHieValue(input.coverageReference),
      verificationStatus: input.verificationStatus,
      verificationSource: input.verificationSource,
      verificationReference: input.verificationReference,
      verificationActorId: actorId,
      verificationExpiresAt: new Date(input.verificationExpiresAt),
      verifiedAt:
        input.verificationStatus === "MANUAL_ATTESTED" ? new Date() : null,
    },
    update: {
      coverageReferenceHash: hashHieIdentifier(input.coverageReference),
      coverageReferenceEncrypted: encryptHieValue(input.coverageReference),
      verificationStatus: input.verificationStatus,
      verificationSource: input.verificationSource,
      verificationReference: input.verificationReference,
      verificationActorId: actorId,
      verificationExpiresAt: new Date(input.verificationExpiresAt),
      verifiedAt:
        input.verificationStatus === "MANUAL_ATTESTED" ? new Date() : null,
    },
    select: {
      id: true,
      patientInsuranceId: true,
      verificationStatus: true,
      verificationSource: true,
      verificationReference: true,
      verificationActorId: true,
      verifiedAt: true,
      verificationExpiresAt: true,
    },
  });
  if (input.verificationStatus === "MANUAL_ATTESTED") {
    await db.hieOutboxEvent.updateMany({
      where: {
        clinicId,
        status: "BLOCKED",
        lastErrorCode: "COVERAGE_REFERENCE_REQUIRED",
      },
      data: {
        status: "PENDING",
        nextAttemptAt: new Date(),
        dependencyReason: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
  }
  return jsonSuccess(c, { data: mapping });
}

export async function listNationalAudit(c: Context<AppEnv>) {
  const { clinicId } = tenant(c);
  const query = c.get("validatedQuery") as NationalAuditQuery;
  await requireCapability(clinicId, "nationalAuditReadEnabled");
  let patientReference: string | undefined;
  if (query.patientId) {
    const patient = await db.patient.findFirst({
      where: {
        id: query.patientId,
        clinics: { some: { id: clinicId } },
      },
      select: { id: true },
    });
    if (!patient) {
      throw notFoundError("Patient not found");
    }
    const identity = await db.patientExternalIdentity.findFirst({
      where: {
        patientId: query.patientId,
        verificationStatus: "VERIFIED",
        resourceIdEncrypted: { not: null },
      },
      orderBy: { verifiedAt: "desc" },
    });
    if (!identity?.resourceIdEncrypted) {
      throw new AppError({
        status: 409,
        code: "HIE_PATIENT_NOT_LINKED",
        message: "Link the patient before reading its national audit trail",
        exposeMessage: true,
      });
    }
    patientReference = decryptHieValue(identity.resourceIdEncrypted);
  }
  const response = await rhieRequest({
    service: "SHR",
    method: "GET",
    path: "AuditEvent",
    query: {
      ...(patientReference ? { patient: patientReference } : {}),
      page: String(query.page),
      per_page: String(query.per_page),
    },
  });
  const bundle = fhirBundleSchema.parse(response.data);
  const items = (bundle.entry ?? []).flatMap((entry) => {
    const resource = entry.resource as Record<string, unknown> | undefined;
    if (resource?.resourceType !== "AuditEvent") {
      return [];
    }
    const auditType = resource.type;
    const auditTypeCode =
      auditType && typeof auditType === "object" && "code" in auditType
        ? (auditType as { code?: unknown }).code
        : auditType;
    return [
      {
        id: typeof resource.id === "string" ? resource.id : null,
        type: typeof auditTypeCode === "string" ? auditTypeCode : null,
        action: typeof resource.action === "string" ? resource.action : null,
        recorded:
          typeof resource.recorded === "string" ? resource.recorded : null,
        outcome: typeof resource.outcome === "string" ? resource.outcome : null,
      },
    ];
  });
  return jsonSuccess(c, {
    data: items,
    meta: {
      page: query.page,
      perPage: query.per_page,
      totalCount: bundle.total ?? items.length,
      pageCount: Math.ceil((bundle.total ?? items.length) / query.per_page),
    },
  });
}

export async function refreshDobDiscrepancies(c: Context<AppEnv>) {
  const { clinicId } = tenant(c);
  const identities = await db.patientExternalIdentity.findMany({
    where: {
      verificationStatus: "VERIFIED",
      demographicsSnapshotEncrypted: { not: null },
      patient: { clinics: { some: { id: clinicId } } },
    },
    select: {
      id: true,
      patientId: true,
      demographicsSnapshotEncrypted: true,
      patient: { select: { dateOfBirth: true, updatedAt: true } },
    },
  });
  let discovered = 0;
  for (const identity of identities) {
    const snapshot = z
      .object({ birthDate: z.iso.date() })
      .safeParse(decryptHieJson(identity.demographicsSnapshotEncrypted ?? ""));
    if (!snapshot.success) {
      continue;
    }
    const local = identity.patient.dateOfBirth.toISOString().slice(0, 10);
    if (local === snapshot.data.birthDate) {
      continue;
    }
    await db.hieDobDiscrepancy.upsert({
      where: {
        clinicId_patientId_identityId: {
          clinicId,
          patientId: identity.patientId,
          identityId: identity.id,
        },
      },
      create: {
        clinicId,
        patientId: identity.patientId,
        identityId: identity.id,
        localDate: dateOnly(local),
        nationalDate: dateOnly(snapshot.data.birthDate),
        expectedUpdatedAt: identity.patient.updatedAt,
      },
      update: {
        localDate: dateOnly(local),
        nationalDate: dateOnly(snapshot.data.birthDate),
        expectedUpdatedAt: identity.patient.updatedAt,
        status: "OPEN",
      },
    });
    discovered += 1;
  }
  return jsonSuccess(c, { data: { discovered } });
}

export async function listDobDiscrepancies(c: Context<AppEnv>) {
  const { clinicId } = tenant(c);
  const query = c.get("validatedQuery") as DobQuery;
  const where = { clinicId, status: query.status };
  const [items, totalCount] = await Promise.all([
    db.hieDobDiscrepancy.findMany({
      where,
      select: {
        id: true,
        patientId: true,
        localDate: true,
        nationalDate: true,
        status: true,
        expectedUpdatedAt: true,
        reviewedAt: true,
        createdAt: true,
        patient: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page,
    }),
    db.hieDobDiscrepancy.count({ where }),
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

export async function resolveDobDiscrepancy(c: Context<AppEnv>) {
  const { clinicId, actorId, user } = tenant(c);
  if (user.role !== "CLINIC_ADMIN") {
    throw new AppError({
      status: 403,
      code: "HIE_DOB_ADMIN_REQUIRED",
      message:
        "Only a clinic administrator can review date-of-birth discrepancies",
    });
  }
  const id = Number(c.req.param("id"));
  const input = c.get("validatedJson") as DobCorrection;
  const discrepancy = await db.hieDobDiscrepancy.findFirst({
    where: { id, clinicId, status: "OPEN" },
  });
  if (!discrepancy) {
    throw notFoundError("Date-of-birth discrepancy not found");
  }
  if (
    discrepancy.expectedUpdatedAt.toISOString() !==
    input.expectedPatientUpdatedAt
  ) {
    throw new AppError({
      status: 409,
      code: "HIE_PATIENT_CHANGED",
      message: "The patient changed after this discrepancy was detected",
      exposeMessage: true,
    });
  }
  const resolved = await db.$transaction(async (tx) => {
    if (input.action === "CORRECT") {
      await tx.patient.update({
        where: { id: discrepancy.patientId },
        data: { dateOfBirth: discrepancy.nationalDate },
      });
    }
    return tx.hieDobDiscrepancy.update({
      where: { id },
      data: {
        status: input.action === "CORRECT" ? "CORRECTED" : "DISMISSED",
        reviewedById: actorId,
        reviewedAt: new Date(),
        reviewNote: input.note,
      },
    });
  });
  return jsonSuccess(c, { data: resolved });
}
