import { z } from "zod";

/**
 * Contract for the NIDA-backed citizen lookup exposed by the HIE at
 * `POST /getCitizen`.
 *
 * This is deliberately *not* a FHIR endpoint — it returns a plain JSON envelope
 * rather than a Bundle, so it has its own schemas and its own media type. The
 * shape is pinned against `docs/rhie-swagger-2026-08-11.yaml`
 * (`components.schemas.Citizen` / `CitizenData`).
 */

/** Document types the HIE accepts as a citizen search key. */
export const citizenDocumentTypeSchema = z.enum([
  "NID",
  "NIDA",
  "NID_APPLICATION_NUMBER",
  "APPLICATION_NUMBER",
  "NIN",
  "OTHERS",
  "PASSPORT",
  "UPI",
  "TEMPID",
  "FOREIGNER_ID",
  "RESOLVE_UPI",
]);

export type CitizenDocumentType = z.infer<typeof citizenDocumentTypeSchema>;

const FOSA_CODE_PATTERN = /^\d{4}$/;

export const citizenRequestSchema = z.object({
  documentType: citizenDocumentTypeSchema,
  documentNumber: z.string().trim().min(1).max(64),
  /** Four-digit facility code identifying the requesting FOSA. */
  fosaid: z.string().trim().regex(FOSA_CODE_PATTERN, "fosaid must be 4 digits"),
});

export type CitizenRequest = z.infer<typeof citizenRequestSchema>;

/**
 * The response envelope. Every `data` field is optional because the registry
 * populates them according to the document type and the citizen's record; only
 * the envelope itself is guaranteed. Unknown fields are stripped rather than
 * rejected so an additive upstream change cannot break the lookup.
 */
export const citizenDataSchema = z.object({
  status: z.string().optional(),
  data: z
    .object({
      documentType: z.string().nullish(),
      documentNumber: z.string().nullish(),
      applicationNumber: z.string().nullish(),
      nin: z.string().nullish(),
      upi: z.string().nullish(),
      nid: z.string().nullish(),
      passportNumber: z.string().nullish(),
      surName: z.string().nullish(),
      postNames: z.string().nullish(),
      fatherName: z.string().nullish(),
      motherName: z.string().nullish(),
      sex: z.string().nullish(),
      dateOfBirth: z.string().nullish(),
      placeOfBirth: z.string().nullish(),
      countryOfBirth: z.string().nullish(),
      domicileCountry: z.string().nullish(),
      domicileProvince: z.string().nullish(),
      domicileDistrict: z.string().nullish(),
      domicileSector: z.string().nullish(),
      domicileCell: z.string().nullish(),
      domicileVillage: z.string().nullish(),
      civilStatus: z.string().nullish(),
      maritalStatus: z.string().nullish(),
      citizenStatus: z.string().nullish(),
      nationality: z.string().nullish(),
      fosaid: z.string().nullish(),
      nidaServiceAvailable: z.union([z.boolean(), z.string()]).nullish(),
    })
    .nullish(),
});

export type CitizenData = z.infer<typeof citizenDataSchema>;
