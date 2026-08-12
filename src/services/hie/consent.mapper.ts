import { z } from "zod";

const consentInputSchema = z.object({
  id: z.string().uuid(),
  patientReference: z.string().min(1),
  scope: z.enum(["patient-privacy", "treatment", "research"]),
  purpose: z.string().trim().min(1),
  recordedAt: z.date(),
});

export function mapHieConsent(input: z.infer<typeof consentInputSchema>) {
  const value = consentInputSchema.parse(input);
  return {
    resourceType: "Consent" as const,
    id: value.id,
    status: "active" as const,
    scope: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/consentscope",
          code: value.scope,
          display: value.scope,
        },
      ],
    },
    category: [
      {
        coding: [
          {
            system: "http://loinc.org",
            code: "59284-0",
            display: value.purpose,
          },
        ],
      },
    ],
    patient: { reference: `Patient/${value.patientReference}` },
    dateTime: value.recordedAt.toISOString(),
  };
}
