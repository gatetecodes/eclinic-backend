import { z } from "zod";
import {
  CARELOGIC_SYSTEM,
  CLINICAL_SYSTEM,
  EXTENSION_URL,
  HL7_SYSTEM,
  RWANDA_SYSTEM,
  TRANSFER_CODE_SYSTEM,
} from "./terminology";

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
      system: HL7_SYSTEM.actCode,
      code: "AMB",
      display: "ambulatory",
    },
    type: [
      {
        coding: [
          {
            system: RWANDA_SYSTEM.encounterType,
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

const codedValueSchema = z.object({
  code: z.string().trim().min(1),
  display: z.string().trim().min(1),
});

const transferPublicationInputSchema = visitPublicationInputSchema.extend({
  parentEncounterReference: z.string().min(1),
  originReference: z.string().regex(/^Location\/.+/),
  destinationReference: z.string().regex(/^Location\/.+/),
  reason: z.string().min(1),
  /**
   * Everything below is optional on purpose. The MoH reference transfer payload
   * carries far more context than the base R4 Encounter has elements for, but a
   * transfer that predates the richer capture fields — or one recorded in a
   * hurry during an emergency — must still publish. Absent values are omitted
   * from the payload rather than sent empty.
   */
  emergency: z.boolean().default(false),
  transferType: codedValueSchema.nullish(),
  transportType: codedValueSchema.nullish(),
  insuranceType: codedValueSchema.nullish(),
  ambulanceCallTime: z.date().nullish(),
  departureTime: z.date().nullish(),
  receivingClinicianContact: z.string().trim().min(1).nullish(),
  caregiverName: z.string().trim().min(1).nullish(),
  caregiverPhone: z.string().trim().min(1).nullish(),
  vitalSignsSummary: z.string().trim().min(1).nullish(),
  labResultsSummary: z.string().trim().min(1).nullish(),
  proceduresSummary: z.string().trim().min(1).nullish(),
  primaryDiagnosis: z
    .object({
      conditionReference: z.string().trim().min(1),
      display: z.string().trim().min(1),
    })
    .nullish(),
});

export type TransferPublicationInput = z.input<
  typeof transferPublicationInputSchema
>;

type TransferValue = z.infer<typeof transferPublicationInputSchema>;

type Extension = Record<string, unknown>;

function codeableExtension(
  url: string,
  system: string,
  value: { code: string; display: string } | null | undefined
): Extension[] {
  return value
    ? [
        {
          url,
          valueCodeableConcept: {
            coding: [{ system, code: value.code, display: value.display }],
          },
        },
      ]
    : [];
}

function dateTimeExtension(
  url: string,
  value: Date | null | undefined
): Extension[] {
  return value ? [{ url, valueDateTime: value.toISOString() }] : [];
}

function stringExtension(
  url: string,
  value: string | null | undefined
): Extension[] {
  return value ? [{ url, valueString: value }] : [];
}

function caregiverExtension(value: TransferValue): Extension[] {
  const parts = [
    ...(value.caregiverName
      ? [{ url: "name", valueString: value.caregiverName }]
      : []),
    ...(value.caregiverPhone
      ? [{ url: "phone", valueString: value.caregiverPhone }]
      : []),
  ];
  return parts.length > 0
    ? [{ url: EXTENSION_URL.caregiverInfo, extension: parts }]
    : [];
}

function transferExtensions(value: TransferValue): Extension[] {
  return [
    ...codeableExtension(
      EXTENSION_URL.transferType,
      TRANSFER_CODE_SYSTEM.transferType,
      value.transferType
    ),
    ...codeableExtension(
      EXTENSION_URL.transportType,
      TRANSFER_CODE_SYSTEM.transportType,
      value.transportType
    ),
    ...codeableExtension(
      EXTENSION_URL.insuranceType,
      TRANSFER_CODE_SYSTEM.insuranceType,
      value.insuranceType
    ),
    ...dateTimeExtension(
      EXTENSION_URL.ambulanceCallTime,
      value.ambulanceCallTime
    ),
    ...dateTimeExtension(EXTENSION_URL.departureTime, value.departureTime),
    ...stringExtension(
      EXTENSION_URL.receivingClinicianContact,
      value.receivingClinicianContact
    ),
    ...caregiverExtension(value),
    ...stringExtension(EXTENSION_URL.vitalSigns, value.vitalSignsSummary),
    ...stringExtension(EXTENSION_URL.labResults, value.labResultsSummary),
    ...stringExtension(
      EXTENSION_URL.proceduresTreatments,
      value.proceduresSummary
    ),
  ];
}

/** Elapsed transfer time in hours, omitted while the transfer is still open. */
function transferLength(value: TransferValue) {
  if (!value.endedAt) {
    return {};
  }
  const hours =
    (value.endedAt.getTime() - value.startedAt.getTime()) / (1000 * 60 * 60);
  if (!(Number.isFinite(hours) && hours > 0)) {
    return {};
  }
  return {
    length: {
      value: Number(hours.toFixed(2)),
      unit: "hours",
      system: CLINICAL_SYSTEM.ucum,
      code: "h",
    },
  };
}

export function mapTransferEncounter(input: TransferPublicationInput) {
  const value = transferPublicationInputSchema.parse(input);
  const extension = transferExtensions(value);
  return {
    resourceType: "Encounter" as const,
    id: value.id,
    ...(extension.length > 0 ? { extension } : {}),
    ...encounterLifecycle(value.startedAt, value.endedAt),
    class: value.emergency
      ? { system: HL7_SYSTEM.actCode, code: "EMER", display: "Emergency" }
      : { system: HL7_SYSTEM.actCode, code: "AMB", display: "ambulatory" },
    type: [
      {
        coding: [
          {
            system: RWANDA_SYSTEM.encounterType,
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
        type: [
          {
            coding: [
              {
                system: HL7_SYSTEM.participationType,
                code: "REF",
                display: "Referrer",
              },
            ],
          },
        ],
        individual: {
          reference: `Practitioner/${value.practitionerReference}`,
        },
      },
    ],
    ...transferLength(value),
    reasonCode: [{ text: value.reason }],
    ...(value.primaryDiagnosis
      ? {
          diagnosis: [
            {
              condition: {
                reference: `Condition/${value.primaryDiagnosis.conditionReference}`,
                display: value.primaryDiagnosis.display,
              },
              use: {
                coding: [
                  {
                    system: HL7_SYSTEM.diagnosisRole,
                    code: "AD",
                    display: "Admission diagnosis",
                  },
                ],
              },
            },
          ],
        }
      : {}),
    hospitalization: {
      origin: { reference: value.originReference },
      admitSource: {
        coding: [
          {
            system: HL7_SYSTEM.admitSource,
            code: "hosp-trans",
            display: "Transferred from other hospital",
          },
        ],
      },
      destination: { reference: value.destinationReference },
      dischargeDisposition: {
        coding: [
          {
            system: HL7_SYSTEM.dischargeDisposition,
            code: "hosp",
            display: "Hospital",
          },
        ],
      },
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
      system: CARELOGIC_SYSTEM.transferIps,
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
                system: CLINICAL_SYSTEM.loinc,
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
