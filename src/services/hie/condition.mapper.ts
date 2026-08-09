import { z } from "zod";

const conditionPublicationInputSchema = z.object({
  id: z.string().uuid(),
  patientReference: z.string().min(1),
  practitionerReference: z.string().min(1),
  encounterReference: z.string().min(1),
  icd11Code: z.string().trim().min(1),
  description: z.string().trim().min(1),
  recordedAt: z.date(),
});

export function mapVisitCondition(
  input: z.infer<typeof conditionPublicationInputSchema>
) {
  const value = conditionPublicationInputSchema.parse(input);
  return {
    resourceType: "Condition" as const,
    id: value.id,
    clinicalStatus: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/condition-clinical",
          code: "active",
        },
      ],
    },
    verificationStatus: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/condition-ver-status",
          code: "confirmed",
        },
      ],
    },
    category: [
      {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/condition-category",
            code: "encounter-diagnosis",
          },
        ],
      },
    ],
    code: {
      coding: [
        {
          system: "https://icd.who.int",
          code: value.icd11Code,
          display: value.description,
        },
      ],
      text: value.description,
    },
    subject: { reference: `Patient/${value.patientReference}` },
    encounter: { reference: `Encounter/${value.encounterReference}` },
    onsetDateTime: value.recordedAt.toISOString(),
    asserter: { reference: `Practitioner/${value.practitionerReference}` },
  };
}
