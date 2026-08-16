import { z } from "zod";
import { CLINICAL_SYSTEM, HL7_SYSTEM } from "./terminology";

const consultationEncounterInputSchema = z.object({
  id: z.string().uuid(),
  patientReference: z.string().min(1),
  practitionerReference: z.string().min(1),
  parentEncounterReference: z.string().min(1),
  locationReference: z.string().regex(/^Location\/.+/),
  startedAt: z.date(),
  endedAt: z.date(),
});

export function mapConsultationEncounter(
  input: z.infer<typeof consultationEncounterInputSchema>
) {
  const value = consultationEncounterInputSchema.parse(input);
  return {
    resourceType: "Encounter" as const,
    id: value.id,
    status: "finished",
    class: {
      system: HL7_SYSTEM.actCode,
      code: "AMB",
      display: "ambulatory",
    },
    type: [
      {
        coding: [
          {
            system: CLINICAL_SYSTEM.snomed,
            code: "11429006",
            display: "Consultation",
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
    period: {
      start: value.startedAt.toISOString(),
      end: value.endedAt.toISOString(),
    },
    location: [{ location: { reference: value.locationReference } }],
    partOf: { reference: `Encounter/${value.parentEncounterReference}` },
  };
}

const consultationObservationInputSchema = z
  .object({
    id: z.string().uuid(),
    patientReference: z.string().min(1),
    practitionerReference: z.string().min(1),
    encounterReference: z.string().min(1),
    codingSystem: z.string().min(1),
    code: z.string().min(1),
    display: z.string().min(1),
    category: z.string().min(1),
    valueText: z.string().min(1).optional(),
    valueNumber: z.number().optional(),
    unit: z.string().min(1).optional(),
    clinicalAt: z.date(),
  })
  .refine(
    (value) => value.valueText !== undefined || value.valueNumber !== undefined,
    {
      message: "A consultation observation requires a value",
    }
  );

export function mapConsultationObservation(
  input: z.infer<typeof consultationObservationInputSchema>
) {
  const value = consultationObservationInputSchema.parse(input);
  return {
    resourceType: "Observation" as const,
    id: value.id,
    status: "final",
    category: [
      {
        coding: [
          {
            system: HL7_SYSTEM.observationCategory,
            code: value.category,
          },
        ],
      },
    ],
    code: {
      coding: [
        {
          system: value.codingSystem,
          code: value.code,
          display: value.display,
        },
      ],
    },
    subject: { reference: `Patient/${value.patientReference}` },
    encounter: { reference: `Encounter/${value.encounterReference}` },
    performer: [{ reference: `Practitioner/${value.practitionerReference}` }],
    effectiveDateTime: value.clinicalAt.toISOString(),
    ...(value.valueNumber !== undefined
      ? {
          valueQuantity: {
            value: value.valueNumber,
            unit: value.unit,
            system: value.unit ? CLINICAL_SYSTEM.ucum : undefined,
            code: value.unit,
          },
        }
      : { valueString: value.valueText }),
  };
}
