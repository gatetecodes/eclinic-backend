/**
 * Canonical code-system and identifier-system URIs for every FHIR resource
 * CareLogic publishes to Rwanda's HIE.
 *
 * Every mapper must source its `system` values from here. Inlining the URI as a
 * string literal at the call site is how `Condition.code` silently drifted onto
 * a non-canonical ICD-11 URI, so the literals live in exactly one place.
 *
 * The values are pinned against the MoH-published FHIR reference payloads
 * (see the HIE Postman collection) and the pinned Swagger contract in
 * `docs/rhie-swagger-2026-08-11.yaml`.
 */

/** HL7-published code systems. */
export const HL7_SYSTEM = {
  actCode: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
  participationType:
    "http://terminology.hl7.org/CodeSystem/v3-ParticipationType",
  observationCategory:
    "http://terminology.hl7.org/CodeSystem/observation-category",
  conditionClinical: "http://terminology.hl7.org/CodeSystem/condition-clinical",
  conditionVerificationStatus:
    "http://terminology.hl7.org/CodeSystem/condition-ver-status",
  conditionCategory: "http://terminology.hl7.org/CodeSystem/condition-category",
  allergyClinical:
    "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
  allergyVerificationStatus:
    "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
  consentScope: "http://terminology.hl7.org/CodeSystem/consentscope",
  consentPolicy: "http://terminology.hl7.org/CodeSystem/consentpolicycodes",
  diagnosisRole: "http://terminology.hl7.org/CodeSystem/diagnosis-role",
  admitSource: "http://terminology.hl7.org/CodeSystem/admit-source",
  dischargeDisposition:
    "http://terminology.hl7.org/CodeSystem/discharge-disposition",
  serviceType: "http://terminology.hl7.org/CodeSystem/service-type",
  routeCodes: "http://terminology.hl7.org/CodeSystem/route-codes",
  locationPhysicalType:
    "http://terminology.hl7.org/CodeSystem/location-physical-type",
} as const;

/** Externally governed clinical terminologies. */
export const CLINICAL_SYSTEM = {
  snomed: "http://snomed.info/sct",
  loinc: "http://loinc.org",
  /**
   * ICD-11 Mortality and Morbidity Statistics. This is the canonical WHO
   * system URI; `https://icd.who.int` is not a registered FHIR system and was
   * previously published in error.
   */
  icd11: "http://id.who.int/icd/release/11/mms",
  rxNorm: "http://www.nlm.nih.gov/research/umls/rxnorm",
  /**
   * ICHI is published by the MoH reference payloads as a bare token rather
   * than a URI. Deviating to a URI would fail their validator, so the token is
   * reproduced verbatim.
   */
  ichi: "ICHI",
  ucum: "http://unitsofmeasure.org",
  dicom: "http://dicom.nema.org/resources/ontology/DCM",
} as const;

/** Rwanda national code systems. */
export const RWANDA_SYSTEM = {
  /** National Pharmaceutical Codes — vaccines and medicinal products. */
  npc: "http://npc.rw",
  encounterType: "http://moh.gov.rw/fhir/CodeSystem/encounter-type",
} as const;

/** URN-scheme systems used for imaging identifiers. */
export const URN_SYSTEM = {
  dicomUid: "urn:dicom:uid",
  rfc3986: "urn:ietf:rfc:3986",
} as const;

const RWANDA_STRUCTURE_DEFINITION = "http://fhir.rw/StructureDefinition";

/**
 * Rwanda FHIR extension URLs. Extensions carry data the base R4 resources have
 * no element for and that the MoH reference payloads expect.
 */
export const EXTENSION_URL = {
  prescribingLocation: `${RWANDA_STRUCTURE_DEFINITION}/prescribing-location`,
  administrationLocation: `${RWANDA_STRUCTURE_DEFINITION}/administration-location`,
  recordedLocation: `${RWANDA_STRUCTURE_DEFINITION}/recorded-location`,
  transferType: `${RWANDA_STRUCTURE_DEFINITION}/transfer-type`,
  transportType: `${RWANDA_STRUCTURE_DEFINITION}/transport-type`,
  ambulanceCallTime: `${RWANDA_STRUCTURE_DEFINITION}/ambulance-call-time`,
  departureTime: `${RWANDA_STRUCTURE_DEFINITION}/departure-time`,
  receivingClinicianContact: `${RWANDA_STRUCTURE_DEFINITION}/receiving-clinician-contact`,
  insuranceType: `${RWANDA_STRUCTURE_DEFINITION}/insurance-type`,
  caregiverInfo: `${RWANDA_STRUCTURE_DEFINITION}/caregiver-info`,
  vitalSigns: `${RWANDA_STRUCTURE_DEFINITION}/vital-signs`,
  labResults: `${RWANDA_STRUCTURE_DEFINITION}/lab-results`,
  proceduresTreatments: `${RWANDA_STRUCTURE_DEFINITION}/procedures-treatments`,
} as const;

/** Rwanda code systems backing the transfer extensions above. */
export const TRANSFER_CODE_SYSTEM = {
  transferType: "http://fhir.rw/CodeSystem/transfer-type",
  transportType: "http://fhir.rw/CodeSystem/transport-type",
  insuranceType: "http://fhir.rw/CodeSystem/insurance-type",
} as const;

/** CareLogic-owned identifier systems. Local scope, never clinical codes. */
export const CARELOGIC_SYSTEM = {
  prescriptionGroup: "https://carelogic.rw/prescriptions",
  transferIps: "https://carelogic.health/fhir/identifier/transfer-ips",
  dischargeIps: "https://carelogic.health/fhir/identifier/discharge-ips",
} as const;

export type Coding = {
  system: string;
  code: string;
  display?: string;
};

/**
 * Builds a `coding[]` array from a required primary coding plus any number of
 * optional secondary codings, dropping the ones that are absent.
 *
 * Dual coding is deliberately additive: the primary entry is the code that
 * gates publication upstream, so a missing or unverified secondary code
 * degrades the payload's richness without ever blocking a publication that
 * would otherwise succeed.
 */
export function dualCoding(
  primary: Coding,
  ...secondary: (Coding | null | undefined)[]
): Coding[] {
  return [
    primary,
    ...secondary.filter((entry): entry is Coding => Boolean(entry?.code)),
  ];
}
