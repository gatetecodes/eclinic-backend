import { type FhirBundle, fhirBundleSchema } from "./fhir.schemas";
import { encryptHieJson } from "./hie-crypto.service";
import { type HieRequestEnvironment, rhieRequest } from "./rhie-client";

const DISPLAYABLE_RESOURCE_TYPES = new Set([
  "AllergyIntolerance",
  "Condition",
  "DiagnosticReport",
  "Encounter",
  "ImagingStudy",
  "Immunization",
  "MedicationAdministration",
  "MedicationDispense",
  "MedicationRequest",
  "Observation",
  "Procedure",
  "ServiceRequest",
]);

type FhirObject = Record<string, unknown>;

function objectValue(value: unknown): FhirObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as FhirObject)
    : null;
}

function firstObject(value: unknown): FhirObject | null {
  return Array.isArray(value) ? objectValue(value[0]) : objectValue(value);
}

function displayString(value: unknown, maxLength = 300): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : null;
}

function resourceCode(resource: FhirObject): FhirObject | null {
  return (
    objectValue(resource.code) ??
    objectValue(resource.medicationCodeableConcept) ??
    firstObject(resource.type)
  );
}

type ProvenanceSummary = {
  author: string | null;
  recordedAt: string | null;
  sourceFacility: string | null;
};

function referenceId(value: unknown): string | null {
  const reference = displayString(objectValue(value)?.reference, 300);
  return reference?.includes("/") ? reference : null;
}

function provenanceByTarget(bundle: FhirBundle) {
  const result = new Map<string, ProvenanceSummary>();
  for (const entry of bundle.entry) {
    const resource = entry.resource;
    if (displayString(resource.resourceType) !== "Provenance") {
      continue;
    }
    const agent = firstObject(resource.agent);
    const who = objectValue(agent?.who);
    const location = objectValue(resource.location);
    const summary = {
      author: displayString(who?.display),
      recordedAt: displayString(resource.recorded, 50),
      sourceFacility: displayString(location?.display),
    };
    const targets = Array.isArray(resource.target) ? resource.target : [];
    for (const target of targets) {
      const reference = referenceId(target);
      if (reference) {
        result.set(reference, summary);
      }
    }
  }
  return result;
}

function summarizeResource(
  resource: FhirObject,
  patientId: number,
  provenance: ProvenanceSummary | undefined
) {
  const resourceType = displayString(resource.resourceType, 100);
  if (!(resourceType && DISPLAYABLE_RESOURCE_TYPES.has(resourceType))) {
    return null;
  }
  const code = resourceCode(resource);
  const coding = firstObject(code?.coding);
  const period = objectValue(resource.period);
  const meta = objectValue(resource.meta);
  const location = firstObject(resource.location);
  const nestedLocation = objectValue(location?.location) ?? location;
  const performer = firstObject(resource.performer);
  const practitioner = objectValue(performer?.individual) ?? performer;
  const resourceId = displayString(resource.id, 200);
  return {
    resourceType,
    resourceId,
    label:
      displayString(code?.text) ??
      displayString(coding?.display) ??
      displayString(resource.description) ??
      displayString(resource.status) ??
      resourceType,
    clinicalDate:
      displayString(resource.effectiveDateTime, 50) ??
      displayString(resource.occurrenceDateTime, 50) ??
      displayString(resource.recordedDate, 50) ??
      displayString(resource.authoredOn, 50) ??
      displayString(period?.start, 50) ??
      displayString(meta?.lastUpdated, 50),
    sourceFacility:
      provenance?.sourceFacility ?? displayString(nestedLocation?.display),
    author: provenance?.author ?? displayString(practitioner?.display),
    provenanceRecordedAt: provenance?.recordedAt ?? null,
    codingSystem: displayString(coding?.system, 200),
    reconciliationToken: resourceId
      ? encryptHieJson({
          patientId,
          resourceType,
          resourceId,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        })
      : null,
  };
}

export function summarizeInternationalPatientSummary(
  bundle: FhirBundle,
  patientId: number
) {
  const provenance = provenanceByTarget(bundle);
  return bundle.entry.flatMap((entry) => {
    const resourceType = displayString(entry.resource.resourceType, 100);
    const resourceId = displayString(entry.resource.id, 200);
    const target =
      resourceType && resourceId ? `${resourceType}/${resourceId}` : "";
    const item = summarizeResource(
      entry.resource,
      patientId,
      provenance.get(target)
    );
    return item ? [item] : [];
  });
}

export async function getInternationalPatientSummary(
  patientReference: string,
  tenantEnvironment: HieRequestEnvironment
) {
  const response = await rhieRequest({
    service: "SHR",
    method: "GET",
    path: "Bundle/$ips",
    tenantEnvironment,
    query: { patient: patientReference },
  });
  return {
    bundle: fhirBundleSchema.parse(response.data),
    correlationId: response.correlationId,
    retrievedAt: new Date().toISOString(),
  };
}

export async function getInternationalPatientSummaryView(
  patientReference: string,
  patientId: number,
  tenantEnvironment: HieRequestEnvironment
) {
  const summary = await getInternationalPatientSummary(
    patientReference,
    tenantEnvironment
  );
  return {
    items: summarizeInternationalPatientSummary(summary.bundle, patientId),
    correlationId: summary.correlationId,
    retrievedAt: summary.retrievedAt,
  };
}
