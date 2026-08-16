import { describe, expect, it } from "bun:test";
import { citizenRequestSchema } from "../citizen.schemas";
import {
  mapLabResultObservation,
  mapLabServiceRequest,
  mapMedicationAdministration,
  mapMedicationDispense,
  mapMedicationRequest,
  mapProcedure,
} from "../clinical-resource.mapper";
import { mapVisitCondition } from "../condition.mapper";
import { mapTransferEncounter, mapVisitEncounter } from "../encounter.mapper";
import { resolveRhieEndpoint } from "../rhie-endpoints";
import { CLINICAL_SYSTEM, EXTENSION_URL, HL7_SYSTEM } from "../terminology";
import { mapVitalObservation } from "../vital-observation.mapper";

/**
 * Conformance tests for the priority clinical flows, pinned against the code
 * systems and payload shapes in the MoH-published HIE Postman collection.
 *
 * These exist so that coding drift fails here rather than at the MoH. Changing
 * a `system` URI must be a deliberate act that updates this file too.
 */

const REFERENCES = {
  id: "37d79901-863c-4289-a9c9-a251dbb7fa23",
  patientReference: "230406-0004-7186",
  practitionerReference: "LIC-00785348",
  encounterReference: "8742f657-fca1-48e0-b0dd-4f41c541e362",
  locationReference: "Location/0424",
};

const DOSAGE = {
  text: "Take one tablet twice daily with food",
  doseValue: 500,
  doseUnit: "mg",
  frequencyCount: 2,
  frequencyPeriod: 1,
  frequencyPeriodUnit: "d" as const,
  routeSystem: HL7_SYSTEM.routeCodes,
  routeCode: "oral",
  routeDisplay: "Oral",
};

/** Every coding a resource carries, flattened to `system|code` pairs. */
function codings(concept: { coding: { system: string; code: string }[] }) {
  return concept.coding.map((entry) => `${entry.system}|${entry.code}`);
}

describe("Condition conformance", () => {
  it("publishes ICD-11 on the canonical WHO system, never the legacy URI", () => {
    const condition = mapVisitCondition({
      ...REFERENCES,
      icd11Code: "5A11",
      description: "Type 2 diabetes mellitus",
      recordedAt: new Date("2026-08-16T09:00:00.000Z"),
    });
    expect(codings(condition.code)).toEqual([
      "http://id.who.int/icd/release/11/mms|5A11",
    ]);
    expect(JSON.stringify(condition)).not.toContain("https://icd.who.int");
  });

  it("dual codes ICD-11 and SNOMED when both are mapped", () => {
    const condition = mapVisitCondition({
      ...REFERENCES,
      icd11Code: "5A11",
      snomedCode: "44054006",
      description: "Type 2 diabetes mellitus",
      recordedAt: new Date("2026-08-16T09:00:00.000Z"),
    });
    expect(codings(condition.code)).toEqual([
      "http://id.who.int/icd/release/11/mms|5A11",
      "http://snomed.info/sct|44054006",
    ]);
  });

  it("carries the HL7 clinical, verification and category statuses", () => {
    const condition = mapVisitCondition({
      ...REFERENCES,
      icd11Code: "5A11",
      description: "Type 2 diabetes mellitus",
      recordedAt: new Date("2026-08-16T09:00:00.000Z"),
    });
    expect(condition.clinicalStatus.coding[0].system).toBe(
      "http://terminology.hl7.org/CodeSystem/condition-clinical"
    );
    expect(condition.verificationStatus.coding[0].system).toBe(
      "http://terminology.hl7.org/CodeSystem/condition-ver-status"
    );
    expect(condition.category[0].coding[0].code).toBe("encounter-diagnosis");
  });
});

describe("Medication conformance", () => {
  const base = { ...REFERENCES, code: "860975", display: "Metformin 500mg" };

  it("publishes SNOMED alone when no RxNorm mapping exists", () => {
    const request = mapMedicationRequest({
      ...base,
      authoredAt: new Date("2026-08-16T09:00:00.000Z"),
      groupIdentifier: "Pres-ord-424-5101974",
      coverageReference: "RSSB-CBHI",
      dosage: DOSAGE,
    });
    expect(codings(request.medicationCodeableConcept)).toEqual([
      "http://snomed.info/sct|860975",
    ]);
  });

  it("dual codes SNOMED and RxNorm across request, dispense and administration", () => {
    const request = mapMedicationRequest({
      ...base,
      rxNormCode: "1049502",
      authoredAt: new Date("2026-08-16T09:00:00.000Z"),
      groupIdentifier: "Pres-ord-424-5101974",
      coverageReference: "RSSB-CBHI",
      dosage: DOSAGE,
    });
    const dispense = mapMedicationDispense({
      ...base,
      rxNormCode: "1049502",
      handedOverAt: new Date("2026-08-16T10:00:00.000Z"),
      quantity: 14,
      unit: "tablet",
      medicationRequestReference: REFERENCES.id,
      dosage: DOSAGE,
    });
    const administration = mapMedicationAdministration({
      ...base,
      rxNormCode: "1049502",
      effectiveAt: new Date("2026-08-16T10:30:00.000Z"),
      reason: "Administered as prescribed",
      medicationRequestReference: REFERENCES.id,
      dosage: {
        ...DOSAGE,
        methodSystem: CLINICAL_SYSTEM.snomed,
        methodCode: "417924000",
      },
    });
    const expected = [
      "http://snomed.info/sct|860975",
      "http://www.nlm.nih.gov/research/umls/rxnorm|1049502",
    ];
    expect(codings(request.medicationCodeableConcept)).toEqual(expected);
    expect(codings(dispense.medicationCodeableConcept)).toEqual(expected);
    expect(codings(administration.medicationCodeableConcept)).toEqual(expected);
  });

  it("expresses dose quantities in UCUM", () => {
    const request = mapMedicationRequest({
      ...base,
      authoredAt: new Date("2026-08-16T09:00:00.000Z"),
      groupIdentifier: "Pres-ord-424-5101974",
      coverageReference: "RSSB-CBHI",
      dosage: DOSAGE,
    });
    const dose = request.dosageInstruction[0].doseAndRate[0].doseQuantity;
    expect(dose.system).toBe("http://unitsofmeasure.org");
    expect(dose.value).toBe(500);
  });

  it("links the dispense to its authorizing prescription", () => {
    const dispense = mapMedicationDispense({
      ...base,
      handedOverAt: new Date("2026-08-16T10:00:00.000Z"),
      quantity: 14,
      unit: "tablet",
      medicationRequestReference: REFERENCES.id,
      dosage: DOSAGE,
    });
    expect(dispense.authorizingPrescription[0].reference).toBe(
      `MedicationRequest/${REFERENCES.id}`
    );
    expect(dispense.whenHandedOver).toBe("2026-08-16T10:00:00.000Z");
  });
});

describe("Lab flow conformance", () => {
  it("codes the lab order with SNOMED and categorises it as a laboratory procedure", () => {
    const order = mapLabServiceRequest({
      ...REFERENCES,
      code: "709971003",
      display: "Full blood count",
      orderedAt: new Date("2026-08-16T09:00:00.000Z"),
    });
    expect(codings(order.code)).toEqual(["http://snomed.info/sct|709971003"]);
    expect(codings(order.category[0])).toEqual([
      "http://snomed.info/sct|108252007",
    ]);
    expect(order.intent).toBe("order");
  });

  it("codes the lab result with LOINC and links it back to the order", () => {
    const result = mapLabResultObservation({
      ...REFERENCES,
      code: "58410-2",
      display: "Complete blood count panel",
      effectiveAt: new Date("2026-08-16T11:00:00.000Z"),
      value: "12.5",
      unit: "g/dL",
      serviceRequestReference: REFERENCES.id,
    });
    expect(codings(result.code)).toEqual(["http://loinc.org|58410-2"]);
    expect(result.category[0].coding[0].code).toBe("laboratory");
    expect(result.basedOn?.[0].reference).toBe(
      `ServiceRequest/${REFERENCES.id}`
    );
    expect(result.valueQuantity?.system).toBe("http://unitsofmeasure.org");
  });

  it("falls back to a string value when the result is not numeric", () => {
    const result = mapLabResultObservation({
      ...REFERENCES,
      code: "58410-2",
      display: "Complete blood count panel",
      effectiveAt: new Date("2026-08-16T11:00:00.000Z"),
      value: "No growth after 48 hours",
    });
    expect(result.valueString).toBe("No growth after 48 hours");
    expect(result.valueQuantity).toBeUndefined();
  });
});

describe("Vital signs conformance", () => {
  it("codes vitals with LOINC under the HL7 vital-signs category", () => {
    const observation = mapVitalObservation({
      id: REFERENCES.id,
      metric: "temperature",
      value: 37.5,
      patientReference: REFERENCES.patientReference,
      practitionerReference: REFERENCES.practitionerReference,
      encounterReference: REFERENCES.encounterReference,
      effectiveAt: new Date("2026-08-16T09:00:00.000Z"),
    });
    expect(codings(observation.code)).toEqual(["http://loinc.org|8310-5"]);
    expect(observation.category[0].coding[0].code).toBe("vital-signs");
    expect(observation.valueQuantity.code).toBe("Cel");
  });
});

describe("Procedure conformance", () => {
  it("codes procedures with ICHI exactly as the MoH payloads do", () => {
    const procedure = mapProcedure({
      ...REFERENCES,
      code: "12345",
      display: "Appendectomy",
      performedAt: new Date("2026-08-16T09:00:00.000Z"),
    });
    expect(codings(procedure.code)).toEqual(["ICHI|12345"]);
    expect(procedure.status).toBe("completed");
    expect(procedure.performer[0].actor.reference).toBe(
      `Practitioner/${REFERENCES.practitionerReference}`
    );
  });
});

describe("Encounter conformance", () => {
  const transferBase = {
    ...REFERENCES,
    parentEncounterReference: "9a8e5398-64ee-4111-84a0-9e1e6e0a0121",
    originReference: "Location/0001",
    destinationReference: "Location/0022",
    reason: "Requires specialist surgical care",
    startedAt: new Date("2026-08-16T01:30:00.000Z"),
    endedAt: new Date("2026-08-16T20:30:00.000Z"),
  };

  it("publishes the visit Encounter as ambulatory on the HL7 ActCode system", () => {
    const encounter = mapVisitEncounter({
      ...REFERENCES,
      startedAt: new Date("2026-08-16T09:00:00.000Z"),
      endedAt: new Date("2026-08-16T10:00:00.000Z"),
    });
    expect(encounter.class.system).toBe(
      "http://terminology.hl7.org/CodeSystem/v3-ActCode"
    );
    expect(encounter.class.code).toBe("AMB");
    expect(encounter.status).toBe("finished");
  });

  it("publishes a minimal transfer without optional context", () => {
    const transfer = mapTransferEncounter(transferBase);
    expect(transfer.class.code).toBe("AMB");
    expect(transfer.type[0].coding[0].code).toBe("TRANSFER_ENCOUNTER");
    expect(transfer).not.toHaveProperty("extension");
    expect(transfer.hospitalization.admitSource.coding[0].code).toBe(
      "hosp-trans"
    );
    expect(transfer.participant[0].type?.[0].coding[0].code).toBe("REF");
  });

  it("marks a high-urgency transfer as an emergency encounter", () => {
    const transfer = mapTransferEncounter({
      ...transferBase,
      emergency: true,
    });
    expect(transfer.class.code).toBe("EMER");
  });

  it("publishes the full MoH transfer extension set when recorded", () => {
    const transfer = mapTransferEncounter({
      ...transferBase,
      emergency: true,
      transferType: { code: "emergency", display: "Emergency" },
      transportType: { code: "ambulance", display: "Ambulance" },
      insuranceType: { code: "cbhi", display: "CBHI - MUTUELLE DE SANTE" },
      ambulanceCallTime: new Date("2026-08-16T01:00:00.000Z"),
      departureTime: new Date("2026-08-16T01:30:00.000Z"),
      receivingClinicianContact: "Dr. John Doe - +250788123456",
      caregiverName: "Jane Doe",
      caregiverPhone: "0783095523",
      vitalSignsSummary: "T: 36.5, SpO2: 98%, RR: 16, Pulse: 72, BP: 120/80",
      labResultsSummary: "Hb 12.5 g/dL",
      proceduresSummary: "IV fluids started",
      primaryDiagnosis: {
        conditionReference: "412",
        display: "Acute appendicitis",
      },
    });
    const urls = (transfer.extension ?? []).map((entry) => entry.url);
    expect(urls).toEqual([
      EXTENSION_URL.transferType,
      EXTENSION_URL.transportType,
      EXTENSION_URL.insuranceType,
      EXTENSION_URL.ambulanceCallTime,
      EXTENSION_URL.departureTime,
      EXTENSION_URL.receivingClinicianContact,
      EXTENSION_URL.caregiverInfo,
      EXTENSION_URL.vitalSigns,
      EXTENSION_URL.labResults,
      EXTENSION_URL.proceduresTreatments,
    ]);
    expect(transfer.diagnosis?.[0].use.coding[0].code).toBe("AD");
    expect(transfer.length?.unit).toBe("hours");
    expect(transfer.length?.value).toBe(19);
  });

  it("omits length while the transfer is still open", () => {
    const transfer = mapTransferEncounter({ ...transferBase, endedAt: null });
    expect(transfer).not.toHaveProperty("length");
    expect(transfer.status).toBe("in-progress");
  });
});

describe("getCitizen contract", () => {
  it("is admitted by the transport registry as a non-FHIR JSON operation", () => {
    const endpoint = resolveRhieEndpoint({
      service: "CITIZEN",
      method: "POST",
      path: "getCitizen",
    });
    expect(endpoint).toBeDefined();
    expect(endpoint?.mediaType).toBe("json");
  });

  it("is not reachable on the FHIR services", () => {
    expect(
      resolveRhieEndpoint({
        service: "SHR",
        method: "POST",
        path: "getCitizen",
      })
    ).toBeUndefined();
    expect(
      resolveRhieEndpoint({
        service: "CLIENT_REGISTRY",
        method: "POST",
        path: "getCitizen",
      })
    ).toBeUndefined();
  });

  it("requires a four-digit FOSA code", () => {
    expect(
      citizenRequestSchema.safeParse({
        documentType: "NID",
        documentNumber: "1199080021631043",
        fosaid: "2601",
      }).success
    ).toBe(true);
    expect(
      citizenRequestSchema.safeParse({
        documentType: "NID",
        documentNumber: "1199080021631043",
        fosaid: "26",
      }).success
    ).toBe(false);
  });

  it("rejects a document type outside the pinned contract", () => {
    expect(
      citizenRequestSchema.safeParse({
        documentType: "DRIVING_LICENCE",
        documentNumber: "123",
        fosaid: "2601",
      }).success
    ).toBe(false);
  });
});
