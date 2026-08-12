import { z } from "zod";
import { fhirBundleSchema } from "./fhir.schemas";
import {
  type HieRequestEnvironment,
  RhieRequestError,
  rhieRequest,
} from "./rhie-client";
import { summarizeInternationalPatientSummary } from "./shared-record.service";

export const nationalRecordSectionSchema = z.enum([
  "encounters",
  "observations",
  "conditions",
  "allergies",
  "immunizations",
  "serviceRequests",
  "medications",
  "procedures",
  "imaging",
  "transfers",
  "consents",
]);
export type NationalRecordSection = z.infer<typeof nationalRecordSectionSchema>;

const SECTION_ENDPOINTS: Record<
  NationalRecordSection,
  ReadonlyArray<{ path: string; patientQuery: "patient" | "subject" }>
> = {
  encounters: [{ path: "Encounter/$list-encounters", patientQuery: "patient" }],
  observations: [
    { path: "Observation/$list-observations", patientQuery: "patient" },
  ],
  conditions: [{ path: "Condition/$list-conditions", patientQuery: "patient" }],
  allergies: [
    { path: "AllergyIntolerance/$list-allergies", patientQuery: "patient" },
  ],
  immunizations: [
    { path: "Immunization/$list-immunizations", patientQuery: "patient" },
  ],
  serviceRequests: [
    { path: "ServiceRequest/$list-servicerequests", patientQuery: "patient" },
  ],
  medications: [
    {
      path: "MedicationRequest/$list-medicationrequests",
      patientQuery: "patient",
    },
    {
      path: "MedicationDispense/$list-medicationdispenses",
      patientQuery: "subject",
    },
    {
      path: "MedicationAdministration/$list-medicationadministrations",
      patientQuery: "subject",
    },
  ],
  procedures: [{ path: "Procedure/$list-procedures", patientQuery: "patient" }],
  imaging: [{ path: "ImagingStudy", patientQuery: "subject" }],
  transfers: [{ path: "Encounter/$list-transfers", patientQuery: "patient" }],
  consents: [{ path: "Consent/$list-consents", patientQuery: "patient" }],
};

function safeFailure(error: unknown) {
  if (error instanceof RhieRequestError) {
    return { code: error.code, retryable: error.retryable };
  }
  return { code: "NATIONAL_SECTION_UNAVAILABLE", retryable: false };
}

async function retrieveSection(params: {
  section: NationalRecordSection;
  patientReference: string;
  patientId: number;
  tenantEnvironment: HieRequestEnvironment;
}) {
  try {
    const results = await Promise.all(
      SECTION_ENDPOINTS[params.section].map(async (endpoint) => {
        const response = await rhieRequest({
          service: "SHR",
          method: "GET",
          path: endpoint.path,
          tenantEnvironment: params.tenantEnvironment,
          query: { [endpoint.patientQuery]: params.patientReference },
        });
        return {
          response,
          bundle: fhirBundleSchema.parse(response.data),
        };
      })
    );
    const seen = new Set<string>();
    const items = results.flatMap(({ bundle }) =>
      summarizeInternationalPatientSummary(bundle, params.patientId).filter(
        (item) => {
          const key = `${item.resourceType}:${item.resourceId ?? ""}`;
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        }
      )
    );
    return {
      section: params.section,
      status: "SUCCESS" as const,
      items,
      correlationIds: results.map(({ response }) => response.correlationId),
    };
  } catch (error) {
    return {
      section: params.section,
      status: "FAILED" as const,
      items: [],
      error: safeFailure(error),
    };
  }
}

export async function retrieveNationalRecord(params: {
  sections: NationalRecordSection[];
  patientReference: string;
  patientId: number;
  tenantEnvironment: HieRequestEnvironment;
}) {
  const results: Awaited<ReturnType<typeof retrieveSection>>[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < params.sections.length) {
      const index = cursor;
      cursor += 1;
      const section = params.sections[index];
      if (section) {
        results[index] = await retrieveSection({ ...params, section });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, params.sections.length) }, () => worker())
  );
  return {
    sections: results,
    partial: results.some((result) => result.status === "FAILED"),
    retrievedAt: new Date().toISOString(),
  };
}
