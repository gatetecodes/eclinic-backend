import { z } from "zod";

const visitPublicationInputSchema = z.object({
  id: z.string().uuid(),
  patientReference: z.string().min(1),
  practitionerReference: z.string().min(1),
  locationReference: z.string().regex(/^Location\/.+/),
  startedAt: z.date(),
  endedAt: z.date().nullable(),
});

export type VisitPublicationInput = z.infer<typeof visitPublicationInputSchema>;

function encounterLifecycle(startedAt: Date, endedAt: Date | null) {
  return {
    status: endedAt ? ("finished" as const) : ("in-progress" as const),
    period: {
      start: startedAt.toISOString(),
      ...(endedAt ? { end: endedAt.toISOString() } : {}),
    },
  };
}

export function mapVisitEncounter(input: VisitPublicationInput) {
  const value = visitPublicationInputSchema.parse(input);
  return {
    resourceType: "Encounter" as const,
    id: value.id,
    ...encounterLifecycle(value.startedAt, value.endedAt),
    class: {
      system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      code: "AMB",
      display: "ambulatory",
    },
    type: [
      {
        coding: [
          {
            system: "http://moh.gov.rw/fhir/CodeSystem/encounter-type",
            code: "VISIT_ENCOUNTER",
            display: "VISIT_ENCOUNTER",
          },
        ],
      },
    ],
    subject: { reference: `Patient/${value.patientReference}` },
    participant: [
      {
        individual: {
          reference: `Practitioner/${value.practitionerReference}`,
        },
      },
    ],
    location: [{ location: { reference: value.locationReference } }],
  };
}

const transferPublicationInputSchema = visitPublicationInputSchema.extend({
  parentEncounterReference: z.string().min(1),
  originReference: z.string().regex(/^Location\/.+/),
  destinationReference: z.string().regex(/^Location\/.+/),
  reason: z.string().min(1),
});

export type TransferPublicationInput = z.infer<
  typeof transferPublicationInputSchema
>;

export function mapTransferEncounter(input: TransferPublicationInput) {
  const value = transferPublicationInputSchema.parse(input);
  return {
    resourceType: "Encounter" as const,
    id: value.id,
    ...encounterLifecycle(value.startedAt, value.endedAt),
    class: {
      system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      code: "AMB",
      display: "ambulatory",
    },
    type: [
      {
        coding: [
          {
            system: "http://moh.gov.rw/fhir/CodeSystem/encounter-type",
            code: "TRANSFER_ENCOUNTER",
            display: "TRANSFER_ENCOUNTER",
          },
        ],
        text: value.reason,
      },
    ],
    subject: { reference: `Patient/${value.patientReference}` },
    participant: [
      {
        individual: {
          reference: `Practitioner/${value.practitionerReference}`,
        },
      },
    ],
    hospitalization: {
      origin: { reference: value.originReference },
      destination: { reference: value.destinationReference },
    },
    location: [{ location: { reference: value.destinationReference } }],
    partOf: { reference: `Encounter/${value.parentEncounterReference}` },
  };
}

const transferIpsInputSchema = z.object({
  id: z.string().uuid(),
  patientReference: z.string().min(1),
  practitionerReference: z.string().min(1),
  clinicalSummary: z.string().min(10),
  encounter: z.record(z.string(), z.unknown()),
  authoredAt: z.date(),
});

function escapeFhirNarrative(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function mapTransferIpsBundle(
  input: z.infer<typeof transferIpsInputSchema>
) {
  const value = transferIpsInputSchema.parse(input);
  const bundleId = `ips-${value.id}`;
  const compositionId = `composition-${value.id}`;
  return {
    resourceType: "Bundle" as const,
    id: bundleId,
    type: "document" as const,
    timestamp: value.authoredAt.toISOString(),
    identifier: {
      system: "https://carelogic.health/fhir/identifier/transfer-ips",
      value: bundleId,
    },
    entry: [
      {
        fullUrl: `urn:uuid:${compositionId}`,
        resource: {
          resourceType: "Composition",
          id: compositionId,
          status: "final",
          type: {
            coding: [
              {
                system: "http://loinc.org",
                code: "60591-5",
                display: "Patient summary Document",
              },
            ],
          },
          subject: { reference: `Patient/${value.patientReference}` },
          encounter: { reference: `Encounter/${value.id}` },
          date: value.authoredAt.toISOString(),
          author: [
            { reference: `Practitioner/${value.practitionerReference}` },
          ],
          title: "Inter-facility transfer clinical summary",
          section: [
            {
              title: "Clinical summary",
              text: {
                status: "generated",
                div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${escapeFhirNarrative(value.clinicalSummary)}</p></div>`,
              },
            },
          ],
        },
      },
      { fullUrl: `urn:uuid:${value.id}`, resource: value.encounter },
    ],
  };
}
