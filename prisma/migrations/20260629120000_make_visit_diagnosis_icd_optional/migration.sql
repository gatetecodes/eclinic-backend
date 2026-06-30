-- Make the ICD-11 code optional on VisitDiagnosis: diagnoses are recorded as
-- free-text descriptions, with the ICD-11 code as an optional enrichment.
ALTER TABLE "VisitDiagnosis" ALTER COLUMN "icd11Code" DROP NOT NULL;
