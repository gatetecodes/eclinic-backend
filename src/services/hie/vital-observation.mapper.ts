import { z } from "zod";

export const vitalMetricSchema = z.enum([
  "height",
  "weight",
  "temperature",
  "heartRate",
  "respiratory",
  "spo2",
  "bmi",
  "bloodSugar",
]);

export type VitalMetric = z.infer<typeof vitalMetricSchema>;

const VITAL_DEFINITIONS: Record<
  VitalMetric,
  { code: string; display: string; unit: string; unitCode: string }
> = {
  height: {
    code: "8302-2",
    display: "Body height",
    unit: "cm",
    unitCode: "cm",
  },
  weight: {
    code: "29463-7",
    display: "Body weight",
    unit: "kg",
    unitCode: "kg",
  },
  temperature: {
    code: "8310-5",
    display: "Body temperature",
    unit: "°C",
    unitCode: "Cel",
  },
  heartRate: {
    code: "8867-4",
    display: "Heart rate",
    unit: "beats/min",
    unitCode: "/min",
  },
  respiratory: {
    code: "9279-1",
    display: "Respiratory rate",
    unit: "breaths/min",
    unitCode: "/min",
  },
  spo2: {
    code: "2708-6",
    display: "Oxygen saturation",
    unit: "%",
    unitCode: "%",
  },
  bmi: {
    code: "39156-5",
    display: "Body mass index",
    unit: "kg/m²",
    unitCode: "kg/m2",
  },
  bloodSugar: {
    code: "2339-0",
    display: "Glucose in blood",
    unit: "mg/dL",
    unitCode: "mg/dL",
  },
};

const NUMERIC_VALUE_PATTERN = /-?\d+(?:\.\d+)?/;
const EMPTY_VALUE_PATTERN = /^(?:n\/?a|none|null|unknown)$/i;

export function parseVitalValue(raw: string): number | null {
  const normalized = raw.trim();
  if (!normalized || EMPTY_VALUE_PATTERN.test(normalized)) {
    return null;
  }
  const match = normalized.match(NUMERIC_VALUE_PATTERN);
  if (!match) {
    return null;
  }
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

const observationInputSchema = z.object({
  id: z.string().uuid(),
  metric: vitalMetricSchema,
  value: z.number().finite(),
  patientReference: z.string().min(1),
  practitionerReference: z.string().min(1),
  encounterReference: z.string().min(1),
  effectiveAt: z.date(),
});

export function mapVitalObservation(
  input: z.infer<typeof observationInputSchema>
) {
  const value = observationInputSchema.parse(input);
  const definition = VITAL_DEFINITIONS[value.metric];
  return {
    resourceType: "Observation" as const,
    id: value.id,
    status: "final" as const,
    category: [
      {
        coding: [
          {
            system:
              "http://terminology.hl7.org/CodeSystem/observation-category",
            code: "vital-signs",
            display: "Vital Signs",
          },
        ],
      },
    ],
    code: {
      coding: [
        {
          system: "http://loinc.org",
          code: definition.code,
          display: definition.display,
        },
      ],
    },
    subject: { reference: `Patient/${value.patientReference}` },
    encounter: { reference: `Encounter/${value.encounterReference}` },
    performer: [{ reference: `Practitioner/${value.practitionerReference}` }],
    effectiveDateTime: value.effectiveAt.toISOString(),
    valueQuantity: {
      value: value.value,
      unit: definition.unit,
      system: "http://unitsofmeasure.org",
      code: definition.unitCode,
    },
  };
}
