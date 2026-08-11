import { z } from "zod";

const nonFutureDateTime = z.iso
  .datetime()
  .refine(
    (value) => new Date(value) <= new Date(),
    "Clinical date cannot be in the future"
  );
const nullablePositiveId = z.number().int().positive().nullable().optional();

export const structuredRecordListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
  status: z
    .enum(["DRAFT", "FINAL", "CORRECTED", "ENTERED_IN_ERROR"])
    .optional(),
});

export const clinicalConceptQuerySchema = z.object({
  domain: z.enum([
    "ALLERGY",
    "VACCINE",
    "CONSULTATION_OBSERVATION",
    "IMAGING_PROCEDURE",
    "IMAGING_REASON",
    "BODY_SITE",
    "MEDICATION_ROUTE",
    "ADMINISTRATION_METHOD",
  ]),
  search: z.string().trim().max(100).optional(),
});

export const structuredRecordParamSchema = z.object({
  id: z.string().regex(/^[1-9]\d*$/),
});

export const consultationObservationSchema = z
  .object({
    visitId: z.number().int().positive(),
    practitionerId: z.number().int().positive(),
    branchId: z.number().int().positive(),
    conceptId: z.number().int().positive(),
    category: z.enum(["social-history", "exam", "survey"]),
    valueText: z.string().trim().min(1).max(5000).optional(),
    valueNumber: z.number().finite().optional(),
    unit: z.string().trim().min(1).max(50).optional(),
    clinicalAt: nonFutureDateTime,
  })
  .refine(
    (value) => value.valueText !== undefined || value.valueNumber !== undefined,
    { message: "A consultation observation value is required" }
  );

export const structuredAllergySchema = z.object({
  visitId: nullablePositiveId,
  asserterId: z.number().int().positive(),
  branchId: z.number().int().positive(),
  allergenConceptId: z.number().int().positive(),
  clinicalStatus: z.enum(["active", "inactive", "resolved"]),
  verificationStatus: z.enum([
    "unconfirmed",
    "confirmed",
    "refuted",
    "entered-in-error",
  ]),
  criticality: z
    .enum(["low", "high", "unable-to-assess"])
    .nullable()
    .optional(),
  onsetAt: nonFutureDateTime,
  recordedDate: z.iso.date(),
  reactions: z
    .array(
      z.object({
        manifestationCode: z.string().trim().min(1).max(120),
        manifestationDisplay: z.string().trim().min(1).max(300),
        severity: z.enum(["mild", "moderate", "severe"]).optional(),
      })
    )
    .max(20)
    .default([]),
});

export const structuredImmunizationSchema = z.object({
  visitId: nullablePositiveId,
  performerId: z.number().int().positive(),
  branchId: z.number().int().positive(),
  vaccineConceptId: z.number().int().positive(),
  immunizationStatus: z.enum(["completed", "not-done"]),
  occurrenceAt: nonFutureDateTime,
  lotNumber: z.string().trim().max(120).nullable().optional(),
  expiryDate: z.iso.date().nullable().optional(),
  siteCode: z.string().trim().max(120).nullable().optional(),
  routeCode: z.string().trim().max(120).nullable().optional(),
  nextDueDate: z.iso.date().nullable().optional(),
});

export const correctionNoteSchema = z.object({
  note: z.string().trim().min(3).max(1000),
});
export const structuredAllergyCorrectionSchema = structuredAllergySchema.extend(
  {
    note: z.string().trim().min(3).max(1000),
  }
);
export const structuredImmunizationCorrectionSchema =
  structuredImmunizationSchema.extend({
    note: z.string().trim().min(3).max(1000),
  });

const dicomUid = z
  .string()
  .trim()
  .max(64)
  .regex(/^[0-2](?:\.(?:0|[1-9]\d*))+$/, "Invalid DICOM UID");
const modality = z.enum([
  "CR",
  "CT",
  "DX",
  "MG",
  "MR",
  "NM",
  "PT",
  "US",
  "XA",
  "RF",
]);

export const imagingOrderSchema = z.object({
  visitId: z.number().int().positive(),
  requesterId: z.number().int().positive(),
  performerId: z.number().int().positive(),
  branchId: z.number().int().positive(),
  procedureConceptId: z.number().int().positive(),
  reasonConceptId: z.number().int().positive(),
  reasonCode: z.string().trim().min(1).max(120),
  reasonDisplay: z.string().trim().min(1).max(300),
  occurrenceAt: nonFutureDateTime,
});

export const imagingStudySchema = z.object({
  visitId: z.number().int().positive(),
  practitionerId: z.number().int().positive(),
  branchId: z.number().int().positive(),
  orderId: nullablePositiveId,
  procedureConceptId: z.number().int().positive(),
  reasonConceptId: z.number().int().positive(),
  reasonCode: z.string().trim().min(1).max(120),
  reasonDisplay: z.string().trim().min(1).max(300),
  studyUid: dicomUid,
  modality,
  description: z.string().trim().min(1).max(1000),
  conclusion: z.string().trim().min(1).max(5000),
  conclusionCode: z.string().trim().min(1).max(120),
  startedAt: nonFutureDateTime,
  series: z
    .array(
      z.object({
        seriesUid: dicomUid,
        modality,
        bodySiteCode: z.string().trim().max(120).nullable().optional(),
        bodySiteConceptId: nullablePositiveId,
        description: z.string().trim().max(1000).nullable().optional(),
        startedAt: nonFutureDateTime.nullable().optional(),
        instances: z
          .array(
            z.object({
              sopUid: dicomUid,
              sopClassUid: dicomUid,
              instanceNumber: z.number().int().positive().nullable().optional(),
              title: z.string().trim().max(300).nullable().optional(),
            })
          )
          .min(1)
          .max(1000),
      })
    )
    .min(1)
    .max(100),
});
