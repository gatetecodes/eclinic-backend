import {
  CLINICAL_SYSTEM,
  EXTENSION_URL,
  HL7_SYSTEM,
  RWANDA_SYSTEM,
  URN_SYSTEM,
} from "./terminology";

type ClinicalReferences = {
  id: string;
  patientReference: string;
  encounterReference?: string;
  practitionerReference: string;
  performerReference?: string;
  locationReference: string;
};

type Concept = { system: string; code: string; display: string };

const coding = (concept: Concept) => ({
  system: concept.system,
  code: concept.code,
  display: concept.display,
});

function seriesBodySite(series: {
  bodySite?: Concept | null;
  bodySiteCode?: string | null;
}) {
  if (series.bodySite) {
    return { bodySite: { coding: [coding(series.bodySite)] } };
  }
  if (series.bodySiteCode) {
    return { bodySite: { coding: [{ code: series.bodySiteCode }] } };
  }
  return {};
}

export function mapStructuredAllergy(
  input: ClinicalReferences & {
    allergen: Concept;
    clinicalStatus: string;
    verificationStatus: string;
    criticality?: string | null;
    onsetAt: Date;
    recordedDate: Date;
    reactions?: Array<{
      manifestationCode: string;
      manifestationDisplay: string;
      severity?: string;
    }>;
  }
) {
  return {
    resourceType: "AllergyIntolerance" as const,
    id: input.id,
    clinicalStatus: {
      coding: [
        {
          system: HL7_SYSTEM.allergyClinical,
          code: input.clinicalStatus,
        },
      ],
    },
    verificationStatus: {
      coding: [
        {
          system: HL7_SYSTEM.allergyVerificationStatus,
          code: input.verificationStatus,
        },
      ],
    },
    code: { coding: [coding(input.allergen)], text: input.allergen.display },
    patient: { reference: `Patient/${input.patientReference}` },
    ...(input.encounterReference
      ? { encounter: { reference: `Encounter/${input.encounterReference}` } }
      : {}),
    ...(input.criticality ? { criticality: input.criticality } : {}),
    onsetDateTime: input.onsetAt.toISOString(),
    recordedDate: input.recordedDate.toISOString().slice(0, 10),
    asserter: { reference: `Practitioner/${input.practitionerReference}` },
    reaction: (input.reactions ?? []).map((reaction) => ({
      manifestation: [
        {
          coding: [
            {
              code: reaction.manifestationCode,
              display: reaction.manifestationDisplay,
            },
          ],
        },
      ],
      ...(reaction.severity ? { severity: reaction.severity } : {}),
    })),
    extension: [
      {
        url: EXTENSION_URL.recordedLocation,
        valueReference: { reference: input.locationReference },
      },
    ],
  };
}

export function mapStructuredImmunization(
  input: ClinicalReferences & {
    vaccine: Concept;
    status: "completed" | "not-done";
    occurrenceAt: Date;
    lotNumber?: string | null;
    expiryDate?: Date | null;
    siteCode?: string | null;
    routeCode?: string | null;
  }
) {
  return {
    resourceType: "Immunization" as const,
    id: input.id,
    status: input.status,
    vaccineCode: {
      coding: [coding({ ...input.vaccine, system: RWANDA_SYSTEM.npc })],
      text: input.vaccine.display,
    },
    patient: { reference: `Patient/${input.patientReference}` },
    ...(input.encounterReference
      ? { encounter: { reference: `Encounter/${input.encounterReference}` } }
      : {}),
    occurrenceDateTime: input.occurrenceAt.toISOString(),
    location: { reference: input.locationReference },
    performer: [
      { actor: { reference: `Practitioner/${input.practitionerReference}` } },
    ],
    ...(input.lotNumber ? { lotNumber: input.lotNumber } : {}),
    ...(input.expiryDate
      ? { expirationDate: input.expiryDate.toISOString().slice(0, 10) }
      : {}),
    ...(input.siteCode ? { site: { coding: [{ code: input.siteCode }] } } : {}),
    ...(input.routeCode
      ? { route: { coding: [{ code: input.routeCode }] } }
      : {}),
  };
}

export function mapImagingServiceRequest(
  input: ClinicalReferences & {
    procedure: Concept;
    reason: Concept;
    occurrenceAt: Date;
  }
) {
  return {
    resourceType: "ServiceRequest" as const,
    id: input.id,
    status: "active" as const,
    intent: "order" as const,
    category: [
      {
        coding: [
          {
            system: CLINICAL_SYSTEM.snomed,
            code: "363679005",
            display: "Imaging",
          },
        ],
      },
    ],
    code: { coding: [coding(input.procedure)], text: input.procedure.display },
    reasonCode: [
      { coding: [coding(input.reason)], text: input.reason.display },
    ],
    subject: { reference: `Patient/${input.patientReference}` },
    ...(input.encounterReference
      ? { encounter: { reference: `Encounter/${input.encounterReference}` } }
      : {}),
    occurrenceDateTime: input.occurrenceAt.toISOString(),
    authoredOn: input.occurrenceAt.toISOString(),
    requester: { reference: `Practitioner/${input.practitionerReference}` },
    performer: [
      {
        reference: `Practitioner/${input.performerReference ?? input.practitionerReference}`,
      },
    ],
    locationReference: [{ reference: input.locationReference }],
  };
}

export function mapImagingStudy(
  input: ClinicalReferences & {
    procedure: Concept;
    reason: Concept;
    studyUid: string;
    modality: string;
    description: string;
    conclusion: string;
    conclusionCode: string;
    startedAt: Date;
    series: Array<{
      uid: string;
      modality: string;
      bodySiteCode?: string | null;
      bodySite?: Concept | null;
      description?: string | null;
      instances: Array<{
        uid: string;
        sopClassUid: string;
        number?: number | null;
        title?: string | null;
      }>;
    }>;
  }
) {
  return {
    resourceType: "ImagingStudy" as const,
    id: input.id,
    identifier: [{ system: URN_SYSTEM.dicomUid, value: input.studyUid }],
    status: "available" as const,
    modality: {
      system: CLINICAL_SYSTEM.dicom,
      code: input.modality,
      display: input.modality,
    },
    subject: { reference: `Patient/${input.patientReference}` },
    ...(input.encounterReference
      ? { encounter: { reference: `Encounter/${input.encounterReference}` } }
      : {}),
    started: input.startedAt.toISOString(),
    procedureCode: [
      { coding: [coding(input.procedure)], text: input.procedure.display },
    ],
    reasonCode: [
      { coding: [coding(input.reason)], text: input.reason.display },
    ],
    description: input.description,
    conclusion: input.conclusion,
    conclusionCode: [{ coding: [{ code: input.conclusionCode }] }],
    series: input.series.map((series, index) => ({
      uid: series.uid,
      number: index + 1,
      modality: {
        system: CLINICAL_SYSTEM.dicom,
        code: series.modality,
      },
      ...seriesBodySite(series),
      ...(series.description ? { description: series.description } : {}),
      instance: series.instances.map((instance) => ({
        uid: instance.uid,
        sopClass: { system: URN_SYSTEM.rfc3986, code: instance.sopClassUid },
        ...(instance.number ? { number: instance.number } : {}),
        ...(instance.title ? { title: instance.title } : {}),
      })),
    })),
  };
}
