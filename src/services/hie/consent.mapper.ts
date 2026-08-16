import { z } from "zod";
import { CLINICAL_SYSTEM, HL7_SYSTEM } from "./terminology";

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
          system: HL7_SYSTEM.consentScope,
          code: value.scope,
          display: value.scope,
        },
      ],
    },
    category: [
      {
        coding: [
          {
            system: CLINICAL_SYSTEM.loinc,
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
