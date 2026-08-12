import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  deferVerificationSchema,
  outboxQuerySchema,
  transferQuerySchema,
  updateConfigSchema,
} from "../../../api/v1/hie/hie.validation";
import {
  formatRwandaAdministrativeAddress,
  parseRwandaAdministrativeAddress,
} from "../client-registry.service";
import {
  mapLabResultObservation,
  mapLabServiceRequest,
  mapMedicationAdministration,
  mapMedicationDispense,
  mapMedicationRequest,
  mapProcedure,
} from "../clinical-resource.mapper";
import { mapVisitCondition } from "../condition.mapper";
import { mapDischargeIpsBundle } from "../discharge-ips.mapper";
import {
  mapTransferEncounter,
  mapTransferIpsBundle,
  mapVisitEncounter,
} from "../encounter.mapper";
import {
  capabilityStatementSchema,
  fhirBundleSchema,
  fhirPatientSchema,
} from "../fhir.schemas";
import {
  decryptHieJson,
  decryptHieValue,
  encryptHieJson,
  encryptHieValue,
  hashHieIdentifier,
} from "../hie-crypto.service";
import {
  birthDateStorageWindow,
  prioritizeLinkedCandidates,
} from "../local-patient-matching";
import {
  requireVerifiedTerminology,
  terminologyVerificationFields,
} from "../product-terminology.service";
import { summarizeInternationalPatientSummary } from "../shared-record.service";
import {
  mapVitalObservation,
  parseVitalValue,
} from "../vital-observation.mapper";

const originalKey = process.env.HIE_DATA_ENCRYPTION_KEY;
const originalHashKey = process.env.HIE_IDENTIFIER_HASH_KEY;

beforeEach(() => {
  process.env.HIE_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.HIE_IDENTIFIER_HASH_KEY = Buffer.alloc(32, 8).toString("base64");
});

afterEach(() => {
  process.env.HIE_DATA_ENCRYPTION_KEY = originalKey;
  process.env.HIE_IDENTIFIER_HASH_KEY = originalHashKey;
});

describe("HIE sensitive-value protection", () => {
  it("encrypts with a randomized authenticated envelope", () => {
    const first = encryptHieValue("1199880011223344");
    const second = encryptHieValue("1199880011223344");
    expect(first).not.toBe(second);
    expect(first).not.toContain("1199880011223344");
    expect(decryptHieValue(first)).toBe("1199880011223344");
  });

  it("round-trips JSON and produces stable lookup hashes", () => {
    const envelope = encryptHieJson({ visitId: 42 });
    expect(decryptHieJson(envelope)).toEqual({ visitId: 42 });
    expect(hashHieIdentifier("abc")).toBe(hashHieIdentifier(" ABC "));
  });
});

describe("FHIR boundary validation", () => {
  it("validates CapabilityStatement health responses", () => {
    expect(
      capabilityStatementSchema.parse({
        resourceType: "CapabilityStatement",
        status: "active",
        fhirVersion: "4.0.1",
      }).fhirVersion
    ).toBe("4.0.1");
    expect(() =>
      capabilityStatementSchema.parse({ resourceType: "Bundle" })
    ).toThrow();
  });

  it("accepts a valid RHIE patient and bundle", () => {
    const patient = fhirPatientSchema.parse({
      resourceType: "Patient",
      id: "123456-1234-1234",
      identifier: [{ system: "NID", value: "1199880011223344" }],
      name: [{ family: "Uwase", given: ["Aline"] }],
      gender: "female",
      birthDate: "1988-01-02",
    });
    expect(
      fhirBundleSchema.parse({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: patient }],
      }).entry
    ).toHaveLength(1);
  });

  it("parses the national address hierarchy without repeated FHIR fields", () => {
    const address = parseRwandaAdministrativeAddress({
      line: [
        "Province: Kigali, District: Gasabo, Sector: Kacyiru, Cell: Kamatamu, Village: Uruhongore, VillageId: 0102070112",
      ],
      city: "Kacyiru",
      district: "Gasabo",
      state: "Kigali",
      country: "Rwanda",
    });

    expect(address).toEqual({
      province: { name: "Kigali", id: null },
      district: { name: "Gasabo", id: null },
      sector: { name: "Kacyiru", id: null },
      cell: { name: "Kamatamu", id: null },
      village: { name: "Uruhongore", id: "0102070112" },
    });
    expect(formatRwandaAdministrativeAddress(address)).toBe(
      "Kigali, Gasabo, Kacyiru, Kamatamu, Uruhongore"
    );
  });

  it("converts an IPS to a browser-safe view without patient identifiers", () => {
    const bundle = fhirBundleSchema.parse({
      resourceType: "Bundle",
      type: "document",
      entry: [
        {
          resource: {
            resourceType: "Patient",
            id: "national-patient-id",
            identifier: [{ system: "NID", value: "1199880011223344" }],
          },
        },
        {
          resource: {
            resourceType: "Condition",
            id: "condition-7",
            code: {
              coding: [
                {
                  system: "http://id.who.int/icd/release/11/mms",
                  code: "1A00",
                  display: "Cholera",
                },
              ],
            },
            recordedDate: "2026-08-07T09:00:00.000Z",
            subject: { reference: "Patient/national-patient-id" },
          },
        },
      ],
    });
    const items = summarizeInternationalPatientSummary(bundle, 42);
    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe("Cholera");
    expect(items[0]?.resourceId).toBe("condition-7");
    expect(JSON.stringify(items)).not.toContain("national-patient-id");
    expect(JSON.stringify(items)).not.toContain("1199880011223344");
    const token = items[0]?.reconciliationToken;
    expect(token).toBeTruthy();
    expect(decryptHieJson(token ?? "")).toMatchObject({
      patientId: 42,
      resourceType: "Condition",
      resourceId: "condition-7",
    });
  });

  it("rejects an invalid date", () => {
    expect(() =>
      fhirPatientSchema.parse({
        resourceType: "Patient",
        id: "patient-1",
        birthDate: "01/02/1988",
      })
    ).toThrow();
  });
});

describe("HIE API boundary validation", () => {
  it("accepts every tenant capability flag", () => {
    const capabilities = {
      clientRegistryEnabled: true,
      sharedRecordReadEnabled: true,
      sharedRecordWriteEnabled: true,
      transferEnabled: true,
      consentSyncEnabled: true,
      consultationWriteEnabled: true,
      nationalListReadEnabled: true,
      nationalAuditReadEnabled: true,
      emergencyReadEnabled: true,
      allergyWriteEnabled: true,
      immunizationWriteEnabled: true,
      imagingWriteEnabled: true,
    };

    expect(updateConfigSchema.parse(capabilities)).toEqual(capabilities);
  });

  it("rejects invalid outbox and transfer filters", () => {
    expect(() => outboxQuerySchema.parse({ status: "UNKNOWN" })).toThrow();
    expect(() => transferQuerySchema.parse({ per_page: 101 })).toThrow();
  });

  it("accepts only stable deferred-verification reasons", () => {
    expect(
      deferVerificationSchema.parse({
        patientId: 42,
        nid: "1199880011223344",
        birthDate: "1988-01-02",
        reason: "REGISTRY_UNAVAILABLE",
      }).reason
    ).toBe("REGISTRY_UNAVAILABLE");
    expect(() =>
      deferVerificationSchema.parse({
        patientId: 42,
        nid: "1199880011223344",
        birthDate: "1988-01-02",
        reason: "free text",
      })
    ).toThrow();
  });
});

describe("HIE local patient matching", () => {
  it("prioritizes a verified identity match and removes demographic duplicates", () => {
    expect(
      prioritizeLinkedCandidates(
        [{ id: 42, source: "identity" }],
        [
          { id: 42, source: "demographics" },
          { id: 81, source: "demographics" },
        ]
      )
    ).toEqual([
      { id: 42, source: "identity" },
      { id: 81, source: "demographics" },
    ]);
  });

  it("matches date-only values stored at UTC or Rwanda local midnight", () => {
    const window = birthDateStorageWindow("1992-01-01");
    expect(window.gte <= new Date("1991-12-31T22:00:00.000Z")).toBe(true);
    expect(window.lte >= new Date("1992-01-01T00:00:00.000Z")).toBe(true);
  });
});

describe("Encounter mapping", () => {
  const base = {
    id: "101aa83e-f245-4fb3-831e-fec8dc1196c9",
    patientReference: "123456-1234-1234",
    practitionerReference: "practitioner-7",
    locationReference: "Location/fosa-42",
    startedAt: new Date("2026-08-07T08:00:00.000Z"),
    endedAt: new Date("2026-08-07T09:00:00.000Z"),
  };

  it("maps a finalized local visit", () => {
    const encounter = mapVisitEncounter(base);
    expect(encounter.status).toBe("finished");
    expect(encounter.period.end).toBe("2026-08-07T09:00:00.000Z");
    expect(encounter.subject.reference).toBe("Patient/123456-1234-1234");
    expect(encounter.location[0]?.location.reference).toBe("Location/fosa-42");
  });

  it("keeps an unfinished local visit in progress without an end time", () => {
    const encounter = mapVisitEncounter({ ...base, endedAt: null });

    expect(encounter.status).toBe("in-progress");
    expect(encounter.period).not.toHaveProperty("end");
  });

  it("keeps an inter-facility transfer distinct", () => {
    const encounter = mapTransferEncounter({
      ...base,
      parentEncounterReference: "parent-encounter",
      originReference: "Location/source",
      destinationReference: "Location/destination",
      reason: "Specialist care",
    });
    expect(encounter.partOf.reference).toBe("Encounter/parent-encounter");
    expect(encounter.hospitalization.destination.reference).toBe(
      "Location/destination"
    );
    expect(encounter.status).toBe("finished");
    expect(encounter.period.end).toBe("2026-08-07T09:00:00.000Z");
  });

  it("keeps an unfinished transfer in progress without an end time", () => {
    const encounter = mapTransferEncounter({
      ...base,
      endedAt: null,
      parentEncounterReference: "parent-encounter",
      originReference: "Location/source",
      destinationReference: "Location/destination",
      reason: "Specialist care",
    });

    expect(encounter.status).toBe("in-progress");
    expect(encounter.period).not.toHaveProperty("end");
  });

  it("creates a locally authored transfer IPS and escapes narrative markup", () => {
    const encounter = mapTransferEncounter({
      ...base,
      parentEncounterReference: "parent-encounter",
      originReference: "Location/source",
      destinationReference: "Location/destination",
      reason: "Higher level care",
    });
    const bundle = mapTransferIpsBundle({
      id: base.id,
      patientReference: base.patientReference,
      practitionerReference: base.practitionerReference,
      clinicalSummary: "Needs <urgent> specialist review",
      encounter,
      authoredAt: base.endedAt,
    });
    expect(bundle.type).toBe("document");
    expect(bundle.entry[0]?.resource).toMatchObject({
      resourceType: "Composition",
      status: "final",
    });
    expect(JSON.stringify(bundle)).toContain("&lt;urgent&gt;");
    expect(JSON.stringify(bundle)).not.toContain("<urgent>");
  });
});

describe("Condition mapping", () => {
  it("publishes only an explicitly coded ICD-11 diagnosis", () => {
    const condition = mapVisitCondition({
      id: "37d79901-863c-4289-a9c9-a251dbb7fa23",
      patientReference: "patient-1",
      practitionerReference: "practitioner-1",
      encounterReference: "encounter-1",
      icd11Code: "1A00",
      description: "Cholera",
      recordedAt: new Date("2026-08-07T09:00:00.000Z"),
    });
    expect(condition.code.coding[0]?.system).toBe("https://icd.who.int");
    expect(condition.code.coding[0]?.code).toBe("1A00");
    expect(condition.encounter.reference).toBe("Encounter/encounter-1");
  });

  it("rejects an uncoded diagnosis", () => {
    expect(() =>
      mapVisitCondition({
        id: "37d79901-863c-4289-a9c9-a251dbb7fa23",
        patientReference: "patient-1",
        practitionerReference: "practitioner-1",
        encounterReference: "encounter-1",
        icd11Code: "",
        description: "Free text only",
        recordedAt: new Date("2026-08-07T09:00:00.000Z"),
      })
    ).toThrow();
  });
});

describe("Vital-sign Observation mapping", () => {
  it("normalizes a numeric string to a LOINC and UCUM quantity", () => {
    expect(parseVitalValue("98.5 %")).toBe(98.5);
    const observation = mapVitalObservation({
      id: "37d79901-863c-4289-a9c9-a251dbb7fa23",
      metric: "spo2",
      value: 98.5,
      patientReference: "patient-1",
      practitionerReference: "practitioner-1",
      encounterReference: "encounter-1",
      effectiveAt: new Date("2026-08-07T09:00:00.000Z"),
    });
    expect(observation.code.coding[0]?.system).toBe("http://loinc.org");
    expect(observation.code.coding[0]?.code).toBe("2708-6");
    expect(observation.valueQuantity).toMatchObject({
      value: 98.5,
      system: "http://unitsofmeasure.org",
      code: "%",
    });
  });

  it("rejects non-numeric placeholder values", () => {
    expect(parseVitalValue("N/A")).toBeNull();
    expect(parseVitalValue("unknown")).toBeNull();
  });
});

describe("Phase 3 clinical resource mapping", () => {
  const reference = {
    id: "37d79901-863c-4289-a9c9-a251dbb7fa23",
    patientReference: "patient-1",
    practitionerReference: "practitioner-1",
    encounterReference: "encounter-1",
    locationReference: "Location/facility-1",
    code: "123456",
    display: "Mapped clinical concept",
  };
  const at = new Date("2026-08-11T08:00:00.000Z");

  it("maps coded laboratory orders and final results", () => {
    const order = mapLabServiceRequest({ ...reference, orderedAt: at });
    const result = mapLabResultObservation({
      ...reference,
      effectiveAt: at,
      value: "7.2",
      unit: "mmol/L",
      serviceRequestReference: order.id,
    });
    expect(order.code.coding[0]?.system).toBe("http://snomed.info/sct");
    expect(result.code.coding[0]?.system).toBe("http://loinc.org");
    expect(result.valueQuantity).toMatchObject({
      value: 7.2,
      system: "http://unitsofmeasure.org",
      code: "mmol/L",
    });
    expect(result.basedOn?.[0]?.reference).toBe(`ServiceRequest/${order.id}`);
  });

  it("maps the medication lifecycle with stable references", () => {
    const dosage = {
      text: "500 mg twice daily for 5 days",
      doseValue: 500,
      doseUnit: "mg",
      frequencyCount: 2,
      frequencyPeriod: 1,
      frequencyPeriodUnit: "d",
      routeSystem: "http://snomed.info/sct",
      routeCode: "26643006",
      routeDisplay: "Oral route",
      methodSystem: "http://snomed.info/sct",
      methodCode: "421521009",
      methodDisplay: "Swallow",
      durationValue: 5,
      durationUnit: "d",
    };
    const request = mapMedicationRequest({
      ...reference,
      authoredAt: at,
      groupIdentifier: "prescription-1",
      coverageReference: "coverage-1",
      dosage,
    });
    const dispense = mapMedicationDispense({
      ...reference,
      handedOverAt: at,
      quantity: 10,
      unit: "tablet",
      medicationRequestReference: request.id,
      dosage,
    });
    const administration = mapMedicationAdministration({
      ...reference,
      effectiveAt: at,
      reason: "Treatment of confirmed condition",
      medicationRequestReference: request.id,
      dosage,
    });
    expect(request.medicationCodeableConcept.coding[0]?.system).toBe(
      "http://snomed.info/sct"
    );
    expect(dispense.authorizingPrescription?.[0]?.reference).toBe(
      `MedicationRequest/${request.id}`
    );
    expect(administration.request?.reference).toBe(
      `MedicationRequest/${request.id}`
    );
  });

  it("maps ICHI procedures and an escaped discharge IPS", () => {
    const procedure = mapProcedure({ ...reference, performedAt: at });
    const bundle = mapDischargeIpsBundle({
      id: reference.id,
      patientReference: reference.patientReference,
      practitionerReference: reference.practitionerReference,
      encounterReference: reference.encounterReference,
      authoredAt: at,
      finalDiagnosis: "Stable",
      clinicalSummary: "Recovered after <observation>",
      patientInstructions: null,
      followUpAt: null,
      destination: "Home",
    });
    expect(procedure.code.coding[0]?.system).toBe("ICHI");
    expect(bundle.type).toBe("document");
    expect(JSON.stringify(bundle)).toContain("&lt;observation&gt;");
    expect(JSON.stringify(bundle)).not.toContain("<observation>");
  });
});

describe("Product terminology governance", () => {
  it("records the verifier only for verified mappings", () => {
    const verifiedAt = new Date("2026-08-08T10:00:00.000Z");
    expect(terminologyVerificationFields("VERIFIED", 7, verifiedAt)).toEqual({
      terminologyStatus: "VERIFIED",
      terminologyVerifiedAt: verifiedAt,
      terminologyVerifiedById: 7,
    });
    expect(terminologyVerificationFields("DRAFT", 7, verifiedAt)).toEqual({
      terminologyStatus: "DRAFT",
      terminologyVerifiedAt: null,
      terminologyVerifiedById: null,
    });
  });

  it("blocks unverified terminology from publication", () => {
    const draft = {
      terminologyStatus: "DRAFT" as const,
      icd11Code: null,
      loincCode: null,
      snomedCode: "123",
      ichiCode: null,
      nationalTariffCode: null,
    };
    expect(() => requireVerifiedTerminology(draft, "snomedCode")).toThrow();
    const verified = { ...draft, terminologyStatus: "VERIFIED" as const };
    expect(() => requireVerifiedTerminology(verified, "loincCode")).toThrow();
    expect(requireVerifiedTerminology(verified, "snomedCode")).toBe("123");
  });
});
