-- Dual coding for HIE publication.
-- ICD-11 (Condition) and SNOMED (medications) remain the gating codes; these
-- columns carry the additional coding the MoH reference payloads expect.

ALTER TABLE "VisitDiagnosis" ADD COLUMN "snomedCode" TEXT;

CREATE INDEX "VisitDiagnosis_snomedCode_idx" ON "VisitDiagnosis"("snomedCode");

ALTER TABLE "Product" ADD COLUMN "rxNormCode" TEXT;

CREATE INDEX "Product_rxNormCode_idx" ON "Product"("rxNormCode");

-- Inter-facility transfer context published as FHIR Encounter extensions.
-- Every column is nullable: an emergency transfer must publish even when the
-- referring clinician cannot complete the optional context fields.

ALTER TABLE "HieExternalTransfer"
  ADD COLUMN "transferTypeCode" TEXT,
  ADD COLUMN "transferTypeDisplay" TEXT,
  ADD COLUMN "transportTypeCode" TEXT,
  ADD COLUMN "transportTypeDisplay" TEXT,
  ADD COLUMN "ambulanceCallTime" TIMESTAMP(3),
  ADD COLUMN "departureTime" TIMESTAMP(3),
  ADD COLUMN "receivingClinicianContact" TEXT,
  ADD COLUMN "caregiverName" TEXT,
  ADD COLUMN "caregiverPhone" TEXT;
