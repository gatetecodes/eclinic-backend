import { z } from "zod";
import {
  CARELOGIC_SYSTEM,
  CLINICAL_SYSTEM,
  dualCoding,
  EXTENSION_URL,
  HL7_SYSTEM,
} from "./terminology";

const baseInputSchema = z.object({
  id: z.string().uuid(),
  patientReference: z.string().min(1),
  practitionerReference: z.string().min(1),
  encounterReference: z.string().min(1),
  locationReference: z.string().regex(/^Location\/.+/),
});

const codedInputSchema = baseInputSchema.extend({
  code: z.string().trim().min(1),
  display: z.string().trim().min(1),
});

/**
 * Medication resources publish a SNOMED CT primary coding plus an optional
 * RxNorm coding. SNOMED remains the gating code so an unmapped RxNorm product
 * still publishes.
 */
const medicationCodedInputSchema = codedInputSchema.extend({
  rxNormCode: z.string().trim().min(1).nullish(),
});

function medicationCodeableConcept(value: {
  code: string;
  display: string;
  rxNormCode?: string | null;
}) {
  return {
    coding: dualCoding(
      {
        system: CLINICAL_SYSTEM.snomed,
        code: value.code,
        display: value.display,
      },
      value.rxNormCode
        ? {
            system: CLINICAL_SYSTEM.rxNorm,
            code: value.rxNormCode,
            display: value.display,
          }
        : null
    ),
    text: value.display,
  };
}

export function mapLabServiceRequest(
  input: z.infer<typeof codedInputSchema> & { orderedAt: Date }
) {
  const value = codedInputSchema.extend({ orderedAt: z.date() }).parse(input);
  return {
    resourceType: "ServiceRequest" as const,
    id: value.id,
    status: "active",
    intent: "order",
    category: [
      {
        coding: [
          {
            system: CLINICAL_SYSTEM.snomed,
            code: "108252007",
            display: "Laboratory procedure",
          },
        ],
      },
    ],
    code: {
      coding: [
        {
          system: CLINICAL_SYSTEM.snomed,
          code: value.code,
          display: value.display,
        },
      ],
      text: value.display,
    },
    subject: { reference: `Patient/${value.patientReference}` },
    encounter: { reference: `Encounter/${value.encounterReference}` },
    occurrenceDateTime: value.orderedAt.toISOString(),
    authoredOn: value.orderedAt.toISOString(),
    requester: { reference: `Practitioner/${value.practitionerReference}` },
    performer: [{ reference: `Practitioner/${value.practitionerReference}` }],
    locationReference: [{ reference: value.locationReference }],
  };
}

const labResultInputSchema = codedInputSchema.extend({
  effectiveAt: z.date(),
  value: z.string().trim().min(1),
  unit: z.string().trim().optional(),
  serviceRequestReference: z.string().optional(),
});

export function mapLabResultObservation(
  input: z.infer<typeof labResultInputSchema>
) {
  const value = labResultInputSchema.parse(input);
  const numeric = Number(value.value);
  const resultValue =
    Number.isFinite(numeric) && value.unit
      ? {
          valueQuantity: {
            value: numeric,
            unit: value.unit,
            system: CLINICAL_SYSTEM.ucum,
            code: value.unit,
          },
        }
      : { valueString: value.value };
  return {
    resourceType: "Observation" as const,
    id: value.id,
    status: "final",
    category: [
      {
        coding: [
          {
            system: HL7_SYSTEM.observationCategory,
            code: "laboratory",
          },
        ],
      },
    ],
    code: {
      coding: [
        {
          system: CLINICAL_SYSTEM.loinc,
          code: value.code,
          display: value.display,
        },
      ],
      text: value.display,
    },
    subject: { reference: `Patient/${value.patientReference}` },
    encounter: { reference: `Encounter/${value.encounterReference}` },
    effectiveDateTime: value.effectiveAt.toISOString(),
    performer: [{ reference: `Practitioner/${value.practitionerReference}` }],
    ...(value.serviceRequestReference
      ? {
          basedOn: [
            { reference: `ServiceRequest/${value.serviceRequestReference}` },
          ],
        }
      : {}),
    ...resultValue,
  };
}

const structuredDosageSchema = z.object({
  text: z.string().min(1),
  doseValue: z.number().positive(),
  doseUnit: z.string().min(1),
  frequencyCount: z.number().int().positive(),
  frequencyPeriod: z.number().positive(),
  frequencyPeriodUnit: z.enum(["s", "min", "h", "d", "wk", "mo", "a"]),
  routeSystem: z.string().min(1),
  routeCode: z.string().min(1),
  routeDisplay: z.string().min(1),
  methodSystem: z.string().min(1).optional(),
  methodCode: z.string().min(1).optional(),
  methodDisplay: z.string().min(1).optional(),
  durationValue: z.number().positive().optional(),
  durationUnit: z.enum(["s", "min", "h", "d", "wk", "mo", "a"]).optional(),
});

function mapDosage(value: z.infer<typeof structuredDosageSchema>) {
  return {
    text: value.text,
    timing: {
      repeat: {
        frequency: value.frequencyCount,
        period: value.frequencyPeriod,
        periodUnit: value.frequencyPeriodUnit,
        ...(value.durationValue && value.durationUnit
          ? {
              boundsDuration: {
                value: value.durationValue,
                unit: value.durationUnit,
                system: CLINICAL_SYSTEM.ucum,
                code: value.durationUnit,
              },
            }
          : {}),
      },
    },
    route: {
      coding: [
        {
          system: value.routeSystem,
          code: value.routeCode,
          display: value.routeDisplay,
        },
      ],
    },
    ...(value.methodSystem && value.methodCode
      ? {
          method: {
            coding: [
              {
                system: value.methodSystem,
                code: value.methodCode,
                display: value.methodDisplay,
              },
            ],
          },
        }
      : {}),
    doseAndRate: [
      {
        doseQuantity: {
          value: value.doseValue,
          unit: value.doseUnit,
          system: CLINICAL_SYSTEM.ucum,
          code: value.doseUnit,
        },
      },
    ],
  };
}

function coverageReference(value: string) {
  return value.startsWith("Coverage/") ? value : `Coverage/${value}`;
}

const medicationRequestInputSchema = medicationCodedInputSchema.extend({
  authoredAt: z.date(),
  groupIdentifier: z.string().min(1),
  coverageReference: z.string().min(1),
  dosage: structuredDosageSchema,
});

export function mapMedicationRequest(
  input: z.infer<typeof medicationRequestInputSchema>
) {
  const value = medicationRequestInputSchema.parse(input);
  return {
    resourceType: "MedicationRequest" as const,
    id: value.id,
    status: "active",
    intent: "order",
    medicationCodeableConcept: medicationCodeableConcept(value),
    subject: { reference: `Patient/${value.patientReference}` },
    encounter: { reference: `Encounter/${value.encounterReference}` },
    authoredOn: value.authoredAt.toISOString(),
    requester: { reference: `Practitioner/${value.practitionerReference}` },
    groupIdentifier: {
      system: CARELOGIC_SYSTEM.prescriptionGroup,
      value: value.groupIdentifier,
    },
    insurance: [{ reference: coverageReference(value.coverageReference) }],
    dosageInstruction: [mapDosage(value.dosage)],
    extension: [
      {
        url: EXTENSION_URL.prescribingLocation,
        valueReference: { reference: value.locationReference },
      },
    ],
    dispenseRequest: { performer: { reference: value.locationReference } },
  };
}

const medicationDispenseInputSchema = medicationCodedInputSchema.extend({
  handedOverAt: z.date(),
  quantity: z.number().positive(),
  unit: z.string().min(1),
  medicationRequestReference: z.string().min(1),
  dosage: structuredDosageSchema,
});

export function mapMedicationDispense(
  input: z.infer<typeof medicationDispenseInputSchema>
) {
  const value = medicationDispenseInputSchema.parse(input);
  return {
    resourceType: "MedicationDispense" as const,
    id: value.id,
    status: "completed",
    medicationCodeableConcept: medicationCodeableConcept(value),
    subject: { reference: `Patient/${value.patientReference}` },
    encounter: { reference: `Encounter/${value.encounterReference}` },
    performer: [
      { actor: { reference: `Practitioner/${value.practitionerReference}` } },
    ],
    location: { reference: value.locationReference },
    destination: { reference: value.locationReference },
    whenHandedOver: value.handedOverAt.toISOString(),
    quantity: { value: value.quantity, unit: value.unit },
    authorizingPrescription: [
      {
        reference: `MedicationRequest/${value.medicationRequestReference}`,
      },
    ],
    dosageInstruction: [mapDosage(value.dosage)],
  };
}

const medicationAdministrationInputSchema = medicationCodedInputSchema.extend({
  effectiveAt: z.date(),
  reason: z.string().min(1),
  medicationRequestReference: z.string().min(1),
  dosage: structuredDosageSchema.extend({
    methodSystem: z.string().min(1),
    methodCode: z.string().min(1),
  }),
});

export function mapMedicationAdministration(
  input: z.infer<typeof medicationAdministrationInputSchema>
) {
  const value = medicationAdministrationInputSchema.parse(input);
  const dosage = mapDosage(value.dosage);
  return {
    resourceType: "MedicationAdministration" as const,
    id: value.id,
    status: "completed",
    medicationCodeableConcept: medicationCodeableConcept(value),
    subject: { reference: `Patient/${value.patientReference}` },
    context: { reference: `Encounter/${value.encounterReference}` },
    effectiveDateTime: value.effectiveAt.toISOString(),
    performer: [
      { actor: { reference: `Practitioner/${value.practitionerReference}` } },
    ],
    supportingInformation: [
      { reference: `MedicationRequest/${value.medicationRequestReference}` },
    ],
    reasonReference: [{ display: value.reason }],
    request: {
      reference: `MedicationRequest/${value.medicationRequestReference}`,
    },
    dosage: {
      text: value.dosage.text,
      route: dosage.route,
      method: {
        coding: [
          {
            system: value.dosage.methodSystem,
            code: value.dosage.methodCode,
            display: value.dosage.methodDisplay,
          },
        ],
      },
      dose: {
        value: value.dosage.doseValue,
        unit: value.dosage.doseUnit,
        system: CLINICAL_SYSTEM.ucum,
        code: value.dosage.doseUnit,
      },
    },
    extension: [
      {
        url: EXTENSION_URL.administrationLocation,
        valueReference: { reference: value.locationReference },
      },
    ],
  };
}

const procedureInputSchema = codedInputSchema.extend({ performedAt: z.date() });

export function mapProcedure(input: z.infer<typeof procedureInputSchema>) {
  const value = procedureInputSchema.parse(input);
  return {
    resourceType: "Procedure" as const,
    id: value.id,
    status: "completed",
    code: {
      coding: [
        {
          system: CLINICAL_SYSTEM.ichi,
          code: value.code,
          display: value.display,
        },
      ],
      text: value.display,
    },
    subject: { reference: `Patient/${value.patientReference}` },
    encounter: { reference: `Encounter/${value.encounterReference}` },
    performedDateTime: value.performedAt.toISOString(),
    performer: [
      { actor: { reference: `Practitioner/${value.practitionerReference}` } },
    ],
    location: { reference: value.locationReference },
  };
}
