import { z } from "zod";
import { CLINICAL_SYSTEM, dualCoding, HL7_SYSTEM } from "./terminology";

const conditionPublicationInputSchema = z.object({
  id: z.string().uuid(),
  patientReference: z.string().min(1),
  practitionerReference: z.string().min(1),
  encounterReference: z.string().min(1),
  icd11Code: z.string().trim().min(1),
  /**
   * Optional SNOMED CT diagnosis code. ICD-11 remains the gating code, so an
   * unmapped diagnosis still publishes rather than being blocked.
   */
  snomedCode: z.string().trim().min(1).nullish(),
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
          system: HL7_SYSTEM.conditionClinical,
          code: "active",
        },
      ],
    },
    verificationStatus: {
      coding: [
        {
          system: HL7_SYSTEM.conditionVerificationStatus,
          code: "confirmed",
        },
      ],
    },
    category: [
      {
        coding: [
          {
            system: HL7_SYSTEM.conditionCategory,
            code: "encounter-diagnosis",
          },
        ],
      },
    ],
    code: {
      coding: dualCoding(
        {
          system: CLINICAL_SYSTEM.icd11,
          code: value.icd11Code,
          display: value.description,
        },
        value.snomedCode
          ? {
              system: CLINICAL_SYSTEM.snomed,
              code: value.snomedCode,
              display: value.description,
            }
          : null
      ),
      text: value.description,
    },
    subject: { reference: `Patient/${value.patientReference}` },
    encounter: { reference: `Encounter/${value.encounterReference}` },
    onsetDateTime: value.recordedAt.toISOString(),
    asserter: { reference: `Practitioner/${value.practitionerReference}` },
  };
}
