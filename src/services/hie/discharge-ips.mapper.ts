import { z } from "zod";

const dischargeIpsInputSchema = z.object({
  id: z.string().uuid(),
  patientReference: z.string().min(1),
  practitionerReference: z.string().min(1),
  encounterReference: z.string().min(1),
  authoredAt: z.date(),
  finalDiagnosis: z.string().nullable(),
  clinicalSummary: z.string().nullable(),
  patientInstructions: z.string().nullable(),
  followUpAt: z.date().nullable(),
  destination: z.string().min(1),
});

function escapeNarrative(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function section(title: string, value: string | null) {
  return value
    ? [
        {
          title,
          text: {
            status: "generated",
            div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${escapeNarrative(value)}</p></div>`,
          },
        },
      ]
    : [];
}

export function mapDischargeIpsBundle(
  input: z.infer<typeof dischargeIpsInputSchema>
) {
  const value = dischargeIpsInputSchema.parse(input);
  const bundleId = `discharge-ips-${value.id}`;
  const compositionId = `discharge-composition-${value.id}`;
  const followUp = value.followUpAt
    ? value.followUpAt.toISOString().slice(0, 10)
    : null;
  return {
    resourceType: "Bundle" as const,
    id: bundleId,
    type: "document" as const,
    timestamp: value.authoredAt.toISOString(),
    identifier: {
      system: "https://carelogic.health/fhir/identifier/discharge-ips",
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
                code: "18842-5",
                display: "Discharge summary",
              },
            ],
          },
          subject: { reference: `Patient/${value.patientReference}` },
          encounter: { reference: `Encounter/${value.encounterReference}` },
          date: value.authoredAt.toISOString(),
          author: [
            { reference: `Practitioner/${value.practitionerReference}` },
          ],
          title: "Discharge summary",
          section: [
            ...section("Final diagnosis", value.finalDiagnosis),
            ...section("Clinical course", value.clinicalSummary),
            ...section("Patient instructions", value.patientInstructions),
            ...section("Follow-up", followUp),
            ...section("Discharge destination", value.destination),
          ],
        },
      },
    ],
  };
}
