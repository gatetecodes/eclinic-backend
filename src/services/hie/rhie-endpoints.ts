import type { z } from "zod";
import { citizenDataSchema, citizenRequestSchema } from "./citizen.schemas";
import {
  capabilityStatementSchema,
  fhirAllergySchema,
  fhirAuditEventSchema,
  fhirBundleSchema,
  fhirConditionSchema,
  fhirConsentSchema,
  fhirEncounterSchema,
  fhirImagingStudySchema,
  fhirImmunizationSchema,
  fhirMedicationAdministrationSchema,
  fhirMedicationDispenseSchema,
  fhirMedicationRequestSchema,
  fhirObservationSchema,
  fhirPatientSchema,
  fhirProcedureSchema,
  fhirServiceRequestSchema,
} from "./fhir.schemas";

export type RhieService = "CLIENT_REGISTRY" | "SHR" | "CITIZEN";
export type RhieMethod = "GET" | "POST" | "DELETE";

/**
 * `fhir` sends and accepts `application/fhir+json`. `json` is for the handful
 * of non-FHIR national operations (currently only `getCitizen`) that reject the
 * FHIR media type.
 */
export type RhieMediaType = "fhir" | "json";

type EndpointDescriptor = {
  service: RhieService;
  method: RhieMethod;
  path: string | RegExp;
  requestSchema?: z.ZodType;
  responseSchema?: z.ZodType;
  allowEmptySuccess?: boolean;
  mediaType?: RhieMediaType;
};

const resourceId = (resource: string) =>
  new RegExp(`^${resource}/[A-Za-z0-9.-]+$`);
const body = (schema: z.ZodType) => schema;
const RESERVED_OPERATION_PATHS = new Set([
  "Consent/$list-consents",
  "Encounter/$list-encounters",
  "Encounter/$list-transfers",
  "Encounter/consultation",
  "Encounter/transfer",
  "Observation/$list-observations",
  "Observation/consultation",
  "Observation/lab-results",
  "Observation/vital-signs",
  "AllergyIntolerance/$list-allergies",
  "Immunization/$list-immunizations",
  "ServiceRequest/$list-servicerequests",
  "ServiceRequest/imaging",
  "ServiceRequest/lab",
  "Condition/$list-conditions",
  "Procedure/$list-procedures",
  "MedicationRequest/$list-medicationrequests",
  "MedicationDispense/$list-medicationdispenses",
  "MedicationAdministration/$list-medicationadministrations",
  "Bundle/$ips",
  "Bundle/$submit-ips",
]);

const ENDPOINTS: readonly EndpointDescriptor[] = [
  {
    // Non-FHIR NIDA operation. Resolves a UPID for a patient the Client
    // Registry has no FHIR Patient for yet — the reception dead-end that
    // otherwise blocks every downstream clinical publication.
    service: "CITIZEN",
    method: "POST",
    path: "getCitizen",
    requestSchema: citizenRequestSchema,
    responseSchema: citizenDataSchema,
    mediaType: "json",
  },
  {
    service: "CLIENT_REGISTRY",
    method: "GET",
    path: "Patient",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "CLIENT_REGISTRY",
    method: "GET",
    path: resourceId("Patient"),
    responseSchema: fhirPatientSchema,
  },
  {
    service: "CLIENT_REGISTRY",
    method: "GET",
    path: "metadata",
    responseSchema: capabilityStatementSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "metadata",
    responseSchema: capabilityStatementSchema,
  },

  {
    service: "SHR",
    method: "POST",
    path: "Consent",
    requestSchema: body(fhirConsentSchema),
    responseSchema: fhirConsentSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "Consent",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "Consent/$list-consents",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: resourceId("Consent"),
    responseSchema: fhirConsentSchema,
  },
  {
    service: "SHR",
    method: "DELETE",
    path: resourceId("Consent"),
    allowEmptySuccess: true,
  },

  {
    service: "SHR",
    method: "POST",
    path: "Encounter",
    requestSchema: body(fhirEncounterSchema),
    responseSchema: fhirEncounterSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "Encounter",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "POST",
    path: "Encounter/consultation",
    requestSchema: body(fhirEncounterSchema),
    responseSchema: fhirEncounterSchema,
  },
  {
    service: "SHR",
    method: "POST",
    path: "Encounter/transfer",
    requestSchema: body(fhirEncounterSchema),
    responseSchema: fhirEncounterSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "Encounter/$list-encounters",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "Encounter/$list-transfers",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: resourceId("Encounter"),
    responseSchema: fhirEncounterSchema,
  },

  {
    service: "SHR",
    method: "POST",
    path: "Observation/vital-signs",
    requestSchema: body(fhirObservationSchema),
    responseSchema: fhirObservationSchema,
  },
  {
    service: "SHR",
    method: "POST",
    path: "Observation/consultation",
    requestSchema: body(fhirObservationSchema),
    responseSchema: fhirObservationSchema,
  },
  {
    service: "SHR",
    method: "POST",
    path: "Observation/lab-results",
    requestSchema: body(fhirObservationSchema),
    responseSchema: fhirObservationSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "Observation",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "Observation/$list-observations",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: resourceId("Observation"),
    responseSchema: fhirObservationSchema,
  },

  {
    service: "SHR",
    method: "POST",
    path: "Condition",
    requestSchema: body(fhirConditionSchema),
    responseSchema: fhirConditionSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "Condition",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "Condition/$list-conditions",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: resourceId("Condition"),
    responseSchema: fhirConditionSchema,
  },

  {
    service: "SHR",
    method: "POST",
    path: "AllergyIntolerance",
    requestSchema: body(fhirAllergySchema),
    responseSchema: fhirAllergySchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "AllergyIntolerance",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "AllergyIntolerance/$list-allergies",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: resourceId("AllergyIntolerance"),
    responseSchema: fhirAllergySchema,
  },
  {
    service: "SHR",
    method: "DELETE",
    path: resourceId("AllergyIntolerance"),
    allowEmptySuccess: true,
  },

  {
    service: "SHR",
    method: "POST",
    path: "Immunization",
    requestSchema: body(fhirImmunizationSchema),
    responseSchema: fhirImmunizationSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "Immunization",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "Immunization/$list-immunizations",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: resourceId("Immunization"),
    responseSchema: fhirImmunizationSchema,
  },
  {
    service: "SHR",
    method: "DELETE",
    path: resourceId("Immunization"),
    allowEmptySuccess: true,
  },

  {
    service: "SHR",
    method: "POST",
    path: "ServiceRequest/lab",
    requestSchema: body(fhirServiceRequestSchema),
    responseSchema: fhirServiceRequestSchema,
  },
  {
    service: "SHR",
    method: "POST",
    path: "ServiceRequest/imaging",
    requestSchema: body(fhirServiceRequestSchema),
    responseSchema: fhirServiceRequestSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "ServiceRequest",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "ServiceRequest/$list-servicerequests",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: resourceId("ServiceRequest"),
    responseSchema: fhirServiceRequestSchema,
  },

  {
    service: "SHR",
    method: "POST",
    path: "ImagingStudy",
    requestSchema: body(fhirImagingStudySchema),
    responseSchema: fhirImagingStudySchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "ImagingStudy",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: resourceId("ImagingStudy"),
    responseSchema: fhirImagingStudySchema,
  },

  {
    service: "SHR",
    method: "POST",
    path: "Procedure",
    requestSchema: body(fhirProcedureSchema),
    responseSchema: fhirProcedureSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "Procedure",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "Procedure/$list-procedures",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: resourceId("Procedure"),
    responseSchema: fhirProcedureSchema,
  },

  {
    service: "SHR",
    method: "POST",
    path: "MedicationRequest",
    requestSchema: body(fhirMedicationRequestSchema),
    responseSchema: fhirMedicationRequestSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "MedicationRequest",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "MedicationRequest/$list-medicationrequests",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: resourceId("MedicationRequest"),
    responseSchema: fhirMedicationRequestSchema,
  },
  {
    service: "SHR",
    method: "POST",
    path: "MedicationDispense",
    requestSchema: body(fhirMedicationDispenseSchema),
    responseSchema: fhirMedicationDispenseSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "MedicationDispense",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "MedicationDispense/$list-medicationdispenses",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: resourceId("MedicationDispense"),
    responseSchema: fhirMedicationDispenseSchema,
  },
  {
    service: "SHR",
    method: "POST",
    path: "MedicationAdministration",
    requestSchema: body(fhirMedicationAdministrationSchema),
    responseSchema: fhirMedicationAdministrationSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "MedicationAdministration",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "MedicationAdministration/$list-medicationadministrations",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: resourceId("MedicationAdministration"),
    responseSchema: fhirMedicationAdministrationSchema,
  },

  {
    service: "SHR",
    method: "GET",
    path: "Bundle/$ips",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "POST",
    path: "Bundle/$submit-ips",
    requestSchema: body(fhirBundleSchema),
    allowEmptySuccess: true,
  },
  {
    service: "SHR",
    method: "GET",
    path: resourceId("Bundle"),
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: "AuditEvent",
    responseSchema: fhirBundleSchema,
  },
  {
    service: "SHR",
    method: "GET",
    path: resourceId("AuditEvent"),
    responseSchema: fhirAuditEventSchema,
  },
] as const;

function pathMatches(descriptor: EndpointDescriptor, path: string) {
  return typeof descriptor.path === "string"
    ? descriptor.path === path
    : !RESERVED_OPERATION_PATHS.has(path) && descriptor.path.test(path);
}

export function resolveRhieEndpoint(params: {
  service: RhieService;
  method: RhieMethod;
  path: string;
}) {
  return ENDPOINTS.find(
    (endpoint) =>
      endpoint.service === params.service &&
      endpoint.method === params.method &&
      pathMatches(endpoint, params.path)
  );
}

export const rhieEndpointDescriptors = ENDPOINTS;
