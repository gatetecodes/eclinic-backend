import { z } from "zod";

const identifierSchema = z.object({
  system: z.string().optional(),
  value: z.string().min(1),
});

const humanNameSchema = z.object({
  family: z.string().optional(),
  given: z.array(z.string()).optional(),
});

const telecomSchema = z.object({
  system: z.enum(["phone", "email"]).optional(),
  value: z.string().optional(),
  use: z.string().optional(),
});

const addressSchema = z.object({
  line: z.array(z.string()).optional(),
  city: z.string().optional(),
  district: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  postalCode: z.string().optional(),
});

export const fhirPatientSchema = z
  .object({
    resourceType: z.literal("Patient"),
    id: z.string().min(1),
    identifier: z.array(identifierSchema).default([]),
    active: z.boolean().optional(),
    name: z.array(humanNameSchema).default([]),
    gender: z.enum(["male", "female", "other", "unknown"]).optional(),
    birthDate: z.iso.date().optional(),
    deceasedBoolean: z.boolean().optional(),
    telecom: z.array(telecomSchema).default([]),
    address: z.array(addressSchema).default([]),
  })
  .passthrough();

const bundleEntrySchema = z.object({
  fullUrl: z.string().optional(),
  resource: z.record(z.string(), z.unknown()),
});

export const fhirBundleSchema = z
  .object({
    resourceType: z.literal("Bundle"),
    id: z.string().optional(),
    type: z.string().optional(),
    total: z.number().int().nonnegative().optional(),
    timestamp: z.string().optional(),
    entry: z.array(bundleEntrySchema).default([]),
  })
  .passthrough();

export type FhirPatient = z.infer<typeof fhirPatientSchema>;
export type FhirBundle = z.infer<typeof fhirBundleSchema>;

export const operationOutcomeSchema = z
  .object({
    resourceType: z.literal("OperationOutcome"),
    issue: z
      .array(
        z.object({
          severity: z.string().optional(),
          code: z.string().optional(),
          diagnostics: z.string().optional(),
        })
      )
      .optional(),
  })
  .passthrough();

export const capabilityStatementSchema = z
  .object({
    resourceType: z.literal("CapabilityStatement"),
    status: z.string().min(1),
    fhirVersion: z.string().min(1).optional(),
    rest: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();

export const fhirResourceSchema = <TResourceType extends string>(
  resourceType: TResourceType
) =>
  z
    .object({
      resourceType: z.literal(resourceType),
      id: z.string().min(1).optional(),
    })
    .passthrough();

const referenceSchema = (resourceType: string) =>
  z
    .object({ reference: z.string().regex(new RegExp(`^${resourceType}/.+`)) })
    .passthrough();
const codingSchema = z
  .object({
    system: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
    display: z.string().optional(),
  })
  .passthrough();
const codeableConceptSchema = z
  .object({ coding: z.array(codingSchema).min(1) })
  .passthrough();
const locationExtensionSchema = z.array(
  z.object({ valueReference: referenceSchema("Location") }).passthrough()
);

export const fhirConsentSchema = fhirResourceSchema("Consent").extend({
  status: z.enum([
    "draft",
    "proposed",
    "active",
    "rejected",
    "inactive",
    "entered-in-error",
  ]),
  scope: codeableConceptSchema,
  category: z.array(z.record(z.string(), z.unknown())).min(1),
  patient: referenceSchema("Patient"),
  dateTime: z.iso.datetime(),
});

export const fhirEncounterSchema = fhirResourceSchema("Encounter").extend({
  status: z.string().min(1),
  class: codingSchema,
  type: z.array(codeableConceptSchema).min(1),
  subject: referenceSchema("Patient"),
  participant: z
    .array(
      z.object({ individual: referenceSchema("Practitioner") }).passthrough()
    )
    .min(1),
  period: z.object({
    start: z.iso.datetime(),
    end: z.iso.datetime().optional(),
  }),
  location: z
    .array(z.object({ location: referenceSchema("Location") }).passthrough())
    .min(1),
});

export const fhirObservationSchema = fhirResourceSchema("Observation")
  .extend({
    status: z.string().min(1),
    category: z.array(codeableConceptSchema).min(1),
    code: codeableConceptSchema,
    subject: referenceSchema("Patient"),
    encounter: referenceSchema("Encounter"),
    performer: z.array(referenceSchema("Practitioner")).min(1),
    effectiveDateTime: z.iso.datetime(),
    valueQuantity: z.record(z.string(), z.unknown()).optional(),
    valueCodeableConcept: z.record(z.string(), z.unknown()).optional(),
    valueString: z.string().min(1).optional(),
    valueInteger: z.number().int().optional(),
    valueTime: z.string().optional(),
    valueDateTime: z.iso.datetime().optional(),
  })
  .refine(
    (value) =>
      value.valueQuantity !== undefined ||
      value.valueCodeableConcept !== undefined ||
      value.valueString !== undefined ||
      value.valueInteger !== undefined ||
      value.valueTime !== undefined ||
      value.valueDateTime !== undefined,
    { message: "Observation requires a value" }
  );

export const fhirConditionSchema = fhirResourceSchema("Condition").extend({
  clinicalStatus: codeableConceptSchema,
  verificationStatus: codeableConceptSchema,
  code: codeableConceptSchema,
  subject: referenceSchema("Patient"),
  asserter: referenceSchema("Practitioner"),
});
export const fhirAllergySchema = fhirResourceSchema(
  "AllergyIntolerance"
).extend({
  clinicalStatus: codeableConceptSchema,
  verificationStatus: codeableConceptSchema,
  patient: referenceSchema("Patient"),
  code: codeableConceptSchema,
  recordedDate: z.iso.date(),
  onsetDateTime: z.iso.datetime(),
});
export const fhirImmunizationSchema = fhirResourceSchema("Immunization").extend(
  {
    status: z.enum(["completed", "not-done"]),
    vaccineCode: codeableConceptSchema,
    patient: referenceSchema("Patient"),
    occurrenceDateTime: z.iso.datetime(),
    location: referenceSchema("Location"),
    performer: z
      .array(z.object({ actor: referenceSchema("Practitioner") }).passthrough())
      .min(1),
  }
);
export const fhirServiceRequestSchema = fhirResourceSchema(
  "ServiceRequest"
).extend({
  status: z.enum(["active", "completed"]),
  intent: z.literal("order"),
  category: z.array(codeableConceptSchema).min(1),
  code: codeableConceptSchema,
  subject: referenceSchema("Patient"),
  encounter: referenceSchema("Encounter"),
  occurrenceDateTime: z.iso.datetime(),
  requester: referenceSchema("Practitioner"),
  performer: z.array(referenceSchema("Practitioner")).min(1),
  locationReference: z.array(referenceSchema("Location")).min(1),
});
export const fhirImagingStudySchema = fhirResourceSchema("ImagingStudy").extend(
  {
    status: z.enum(["registered", "available"]),
    modality: codingSchema.extend({
      system: z.literal("https://dicom.nema.org/"),
      code: z.enum([
        "CR",
        "CT",
        "DX",
        "MG",
        "MR",
        "NM",
        "PT",
        "US",
        "XA",
        "RF",
      ]),
    }),
    subject: referenceSchema("Patient"),
    encounter: referenceSchema("Encounter"),
    started: z.iso.datetime(),
    procedureCode: z.array(codeableConceptSchema).min(1),
    reasonCode: z.array(codeableConceptSchema).min(1),
    description: z.string().min(1),
    conclusion: z.string().min(1),
    conclusionCode: z.array(z.record(z.string(), z.unknown())).min(1),
    series: z.array(z.record(z.string(), z.unknown())).min(1),
  }
);
export const fhirProcedureSchema = fhirResourceSchema("Procedure").extend({
  status: z.string().min(1),
  code: codeableConceptSchema,
  subject: referenceSchema("Patient"),
  encounter: referenceSchema("Encounter"),
  performedDateTime: z.iso.datetime(),
  performer: z
    .array(z.object({ actor: referenceSchema("Practitioner") }).passthrough())
    .min(1),
  location: referenceSchema("Location"),
});
export const fhirMedicationRequestSchema = fhirResourceSchema(
  "MedicationRequest"
).extend({
  status: z.string().min(1),
  intent: z.string().min(1),
  medicationCodeableConcept: codeableConceptSchema,
  subject: referenceSchema("Patient"),
  encounter: referenceSchema("Encounter"),
  authoredOn: z.iso.datetime(),
  requester: referenceSchema("Practitioner"),
  groupIdentifier: z.record(z.string(), z.unknown()),
  insurance: z.array(referenceSchema("Coverage")).min(1),
  dosageInstruction: z.array(z.record(z.string(), z.unknown())).min(1),
  extension: locationExtensionSchema.min(1),
});
export const fhirMedicationDispenseSchema = fhirResourceSchema(
  "MedicationDispense"
).extend({
  status: z.string().min(1),
  medicationCodeableConcept: codeableConceptSchema,
  subject: referenceSchema("Patient"),
  encounter: referenceSchema("Encounter"),
  authorizingPrescription: z.array(referenceSchema("MedicationRequest")).min(1),
  performer: z
    .array(z.object({ actor: referenceSchema("Practitioner") }).passthrough())
    .min(1),
  destination: referenceSchema("Location"),
  whenHandedOver: z.iso.datetime(),
  quantity: z.record(z.string(), z.unknown()),
  dosageInstruction: z.array(z.record(z.string(), z.unknown())).min(1),
});
export const fhirMedicationAdministrationSchema = fhirResourceSchema(
  "MedicationAdministration"
).extend({
  status: z.string().min(1),
  medicationCodeableConcept: codeableConceptSchema,
  subject: referenceSchema("Patient"),
  context: referenceSchema("Encounter"),
  supportingInformation: z.array(referenceSchema("MedicationRequest")).min(1),
  effectiveDateTime: z.iso.datetime(),
  performer: z
    .array(z.object({ actor: referenceSchema("Practitioner") }).passthrough())
    .min(1),
  reasonReference: z.array(z.record(z.string(), z.unknown())).min(1),
  request: referenceSchema("MedicationRequest"),
  dosage: z.record(z.string(), z.unknown()),
  extension: locationExtensionSchema.min(1),
});
export const fhirAuditEventSchema = fhirResourceSchema("AuditEvent");
