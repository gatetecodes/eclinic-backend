CREATE TYPE "HieConsentSyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED', 'WITHDRAWAL_PENDING', 'WITHDRAWN');
CREATE TYPE "HieClinicalConceptDomain" AS ENUM ('ALLERGY', 'VACCINE', 'CONSULTATION_OBSERVATION', 'IMAGING_PROCEDURE', 'IMAGING_REASON', 'BODY_SITE', 'MEDICATION_ROUTE', 'ADMINISTRATION_METHOD');
CREATE TYPE "HieStructuredRecordStatus" AS ENUM ('DRAFT', 'FINAL', 'CORRECTED', 'ENTERED_IN_ERROR');
CREATE TYPE "HieEmergencyReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'CONCERN');
CREATE TYPE "HieImagingOrderStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED');
CREATE TYPE "HieImagingStudyStatus" AS ENUM ('REGISTERED', 'AVAILABLE', 'CANCELLED');
ALTER TYPE "HieVerificationStatus" ADD VALUE IF NOT EXISTS 'MANUAL_ATTESTED';

ALTER TABLE "HieTenantConfig"
ADD COLUMN "allergyWriteEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "consentSyncEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "consultationWriteEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "emergencyReadEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "imagingWriteEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "immunizationWriteEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "nationalAuditReadEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "nationalListReadEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "HieFacilityLink"
ADD COLUMN "verificationActorId" INTEGER,
ADD COLUMN "verificationExpiresAt" TIMESTAMP(3),
ADD COLUMN "verificationReference" TEXT,
ADD COLUMN "verificationSource" TEXT;

ALTER TABLE "HieDestinationFacility"
ADD COLUMN "verificationActorId" INTEGER,
ADD COLUMN "verificationExpiresAt" TIMESTAMP(3),
ADD COLUMN "verificationReference" TEXT,
ADD COLUMN "verificationSource" TEXT;

ALTER TABLE "UserExternalIdentity"
ADD COLUMN "verificationActorId" INTEGER,
ADD COLUMN "verificationExpiresAt" TIMESTAMP(3),
ADD COLUMN "verificationReference" TEXT,
ADD COLUMN "verificationSource" TEXT;

ALTER TABLE "HieConsent"
ADD COLUMN "hieVersionEncrypted" TEXT,
ADD COLUMN "lastSyncAttemptAt" TIMESTAMP(3),
ADD COLUMN "lastSyncFailureCode" TEXT,
ADD COLUMN "lastSyncFailureMessage" TEXT,
ADD COLUMN "syncStatus" "HieConsentSyncStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "synchronizedAt" TIMESTAMP(3);

ALTER TABLE "HieOutboxEvent" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "HieOutboxEvent_idempotencyKey_key" ON "HieOutboxEvent"("idempotencyKey");

ALTER TABLE "PrescriptionItem"
ADD COLUMN "doseValue" DECIMAL(14,4), ADD COLUMN "doseUnit" TEXT,
ADD COLUMN "frequencyCount" INTEGER, ADD COLUMN "frequencyPeriod" DECIMAL(14,4),
ADD COLUMN "frequencyPeriodUnit" TEXT, ADD COLUMN "routeSystem" TEXT,
ADD COLUMN "routeCode" TEXT, ADD COLUMN "routeDisplay" TEXT,
ADD COLUMN "methodSystem" TEXT, ADD COLUMN "methodCode" TEXT,
ADD COLUMN "methodDisplay" TEXT, ADD COLUMN "durationValue" DECIMAL(14,4),
ADD COLUMN "durationUnit" TEXT;

ALTER TABLE "WardMedication"
ADD COLUMN "doseValue" DECIMAL(14,4), ADD COLUMN "doseUnit" TEXT,
ADD COLUMN "frequencyCount" INTEGER, ADD COLUMN "frequencyPeriod" DECIMAL(14,4),
ADD COLUMN "frequencyPeriodUnit" TEXT, ADD COLUMN "routeSystem" TEXT,
ADD COLUMN "routeCode" TEXT, ADD COLUMN "routeDisplay" TEXT,
ADD COLUMN "methodSystem" TEXT, ADD COLUMN "methodCode" TEXT,
ADD COLUMN "methodDisplay" TEXT, ADD COLUMN "durationValue" DECIMAL(14,4),
ADD COLUMN "durationUnit" TEXT;

CREATE TABLE "PatientInsuranceExternalIdentity" (
  "id" SERIAL NOT NULL,
  "clinicId" INTEGER NOT NULL,
  "patientInsuranceId" INTEGER NOT NULL,
  "coverageReferenceHash" TEXT NOT NULL,
  "coverageReferenceEncrypted" TEXT NOT NULL,
  "verificationStatus" "HieVerificationStatus" NOT NULL DEFAULT 'PENDING',
  "verificationSource" TEXT NOT NULL,
  "verificationReference" TEXT NOT NULL,
  "verificationActorId" INTEGER NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "verificationExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PatientInsuranceExternalIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HieClinicalConcept" (
  "id" SERIAL NOT NULL,
  "domain" "HieClinicalConceptDomain" NOT NULL,
  "codingSystem" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "display" TEXT NOT NULL,
  "status" "ProductTerminologyStatus" NOT NULL DEFAULT 'DRAFT',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "verifiedById" INTEGER,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HieClinicalConcept_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HieConsultationObservation" (
  "id" SERIAL NOT NULL,
  "clinicId" INTEGER NOT NULL,
  "patientId" INTEGER NOT NULL,
  "visitId" INTEGER NOT NULL,
  "practitionerId" INTEGER NOT NULL,
  "branchId" INTEGER NOT NULL,
  "conceptId" INTEGER NOT NULL,
  "category" TEXT NOT NULL,
  "valueText" TEXT,
  "valueNumber" DECIMAL(14,4),
  "unit" TEXT,
  "clinicalAt" TIMESTAMP(3) NOT NULL,
  "status" "HieStructuredRecordStatus" NOT NULL DEFAULT 'DRAFT',
  "finalizedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HieConsultationObservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HieStructuredAllergy" (
  "id" SERIAL NOT NULL,
  "clinicId" INTEGER NOT NULL,
  "patientId" INTEGER NOT NULL,
  "visitId" INTEGER,
  "asserterId" INTEGER NOT NULL,
  "branchId" INTEGER NOT NULL,
  "allergenConceptId" INTEGER NOT NULL,
  "clinicalStatus" TEXT NOT NULL,
  "verificationStatus" TEXT NOT NULL,
  "criticality" TEXT,
  "onsetAt" TIMESTAMP(3) NOT NULL,
  "recordedDate" DATE NOT NULL,
  "reactions" JSONB,
  "status" "HieStructuredRecordStatus" NOT NULL DEFAULT 'DRAFT',
  "replacesAllergyId" INTEGER,
  "finalizedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HieStructuredAllergy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HieImmunization" (
  "id" SERIAL NOT NULL,
  "clinicId" INTEGER NOT NULL,
  "patientId" INTEGER NOT NULL,
  "visitId" INTEGER,
  "performerId" INTEGER NOT NULL,
  "branchId" INTEGER NOT NULL,
  "vaccineConceptId" INTEGER NOT NULL,
  "immunizationStatus" TEXT NOT NULL,
  "occurrenceAt" TIMESTAMP(3) NOT NULL,
  "lotNumber" TEXT,
  "expiryDate" DATE,
  "siteCode" TEXT,
  "routeCode" TEXT,
  "nextDueDate" DATE,
  "status" "HieStructuredRecordStatus" NOT NULL DEFAULT 'DRAFT',
  "replacesImmunizationId" INTEGER,
  "finalizedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HieImmunization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HieImagingOrder" (
  "id" SERIAL NOT NULL,
  "clinicId" INTEGER NOT NULL,
  "patientId" INTEGER NOT NULL,
  "visitId" INTEGER NOT NULL,
  "requesterId" INTEGER NOT NULL,
  "performerId" INTEGER NOT NULL,
  "branchId" INTEGER NOT NULL,
  "procedureConceptId" INTEGER NOT NULL,
  "reasonConceptId" INTEGER NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "reasonDisplay" TEXT NOT NULL,
  "status" "HieImagingOrderStatus" NOT NULL DEFAULT 'DRAFT',
  "occurrenceAt" TIMESTAMP(3) NOT NULL,
  "finalizedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HieImagingOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HieImagingStudy" (
  "id" SERIAL NOT NULL,
  "clinicId" INTEGER NOT NULL,
  "patientId" INTEGER NOT NULL,
  "visitId" INTEGER NOT NULL,
  "practitionerId" INTEGER NOT NULL,
  "branchId" INTEGER NOT NULL,
  "orderId" INTEGER,
  "procedureConceptId" INTEGER NOT NULL,
  "reasonConceptId" INTEGER NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "reasonDisplay" TEXT NOT NULL,
  "studyUid" TEXT NOT NULL,
  "modality" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "conclusion" TEXT NOT NULL,
  "conclusionCode" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "status" "HieImagingStudyStatus" NOT NULL DEFAULT 'REGISTERED',
  "finalizedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HieImagingStudy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HieImagingSeries" (
  "id" SERIAL NOT NULL,
  "clinicId" INTEGER NOT NULL,
  "studyId" INTEGER NOT NULL,
  "seriesUid" TEXT NOT NULL,
  "modality" TEXT NOT NULL,
  "bodySiteCode" TEXT,
  "bodySiteConceptId" INTEGER,
  "description" TEXT,
  "startedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HieImagingSeries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HieImagingInstance" (
  "id" SERIAL NOT NULL,
  "clinicId" INTEGER NOT NULL,
  "seriesId" INTEGER NOT NULL,
  "sopUid" TEXT NOT NULL,
  "sopClassUid" TEXT NOT NULL,
  "instanceNumber" INTEGER,
  "title" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HieImagingInstance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HieEmergencyAccess" (
  "id" SERIAL NOT NULL,
  "clinicId" INTEGER NOT NULL,
  "patientId" INTEGER NOT NULL,
  "clinicianId" INTEGER NOT NULL,
  "branchId" INTEGER NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "justification" TEXT NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "effectiveTo" TIMESTAMP(3) NOT NULL,
  "outcome" TEXT NOT NULL,
  "reviewStatus" "HieEmergencyReviewStatus" NOT NULL DEFAULT 'PENDING',
  "reviewedById" INTEGER,
  "reviewedAt" TIMESTAMP(3),
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HieEmergencyAccess_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HieDobDiscrepancy" (
  "id" SERIAL NOT NULL,
  "clinicId" INTEGER NOT NULL,
  "patientId" INTEGER NOT NULL,
  "identityId" INTEGER NOT NULL,
  "localDate" DATE NOT NULL,
  "nationalDate" DATE NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "reviewedById" INTEGER,
  "reviewedAt" TIMESTAMP(3),
  "reviewNote" TEXT,
  "expectedUpdatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HieDobDiscrepancy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PatientInsuranceExternalIdentity_clinicId_verificationStatus_idx" ON "PatientInsuranceExternalIdentity"("clinicId", "verificationStatus");
CREATE UNIQUE INDEX "PatientInsuranceExternalIdentity_clinicId_patientInsuranceId_key" ON "PatientInsuranceExternalIdentity"("clinicId", "patientInsuranceId");
CREATE UNIQUE INDEX "PatientInsuranceExternalIdentity_clinicId_coverageReferenceHash_key" ON "PatientInsuranceExternalIdentity"("clinicId", "coverageReferenceHash");
CREATE INDEX "HieClinicalConcept_domain_status_active_idx" ON "HieClinicalConcept"("domain", "status", "active");
CREATE UNIQUE INDEX "HieClinicalConcept_domain_codingSystem_code_key" ON "HieClinicalConcept"("domain", "codingSystem", "code");
CREATE INDEX "HieConsultationObservation_clinicId_patientId_clinicalAt_idx" ON "HieConsultationObservation"("clinicId", "patientId", "clinicalAt");
CREATE INDEX "HieConsultationObservation_clinicId_visitId_status_idx" ON "HieConsultationObservation"("clinicId", "visitId", "status");
CREATE UNIQUE INDEX "HieConsultationObservation_clinicId_id_key" ON "HieConsultationObservation"("clinicId", "id");
CREATE INDEX "HieStructuredAllergy_clinicId_patientId_status_idx" ON "HieStructuredAllergy"("clinicId", "patientId", "status");
CREATE UNIQUE INDEX "HieStructuredAllergy_clinicId_id_key" ON "HieStructuredAllergy"("clinicId", "id");
CREATE INDEX "HieImmunization_clinicId_patientId_status_idx" ON "HieImmunization"("clinicId", "patientId", "status");
CREATE UNIQUE INDEX "HieImmunization_clinicId_id_key" ON "HieImmunization"("clinicId", "id");
CREATE INDEX "HieImagingOrder_clinicId_patientId_status_idx" ON "HieImagingOrder"("clinicId", "patientId", "status");
CREATE INDEX "HieImagingOrder_clinicId_visitId_idx" ON "HieImagingOrder"("clinicId", "visitId");
CREATE UNIQUE INDEX "HieImagingOrder_clinicId_id_key" ON "HieImagingOrder"("clinicId", "id");
CREATE INDEX "HieImagingStudy_clinicId_patientId_status_idx" ON "HieImagingStudy"("clinicId", "patientId", "status");
CREATE INDEX "HieImagingStudy_clinicId_visitId_idx" ON "HieImagingStudy"("clinicId", "visitId");
CREATE UNIQUE INDEX "HieImagingStudy_clinicId_id_key" ON "HieImagingStudy"("clinicId", "id");
CREATE UNIQUE INDEX "HieImagingStudy_clinicId_studyUid_key" ON "HieImagingStudy"("clinicId", "studyUid");
CREATE INDEX "HieImagingSeries_clinicId_studyId_idx" ON "HieImagingSeries"("clinicId", "studyId");
CREATE UNIQUE INDEX "HieImagingSeries_clinicId_seriesUid_key" ON "HieImagingSeries"("clinicId", "seriesUid");
CREATE UNIQUE INDEX "HieImagingSeries_clinicId_id_key" ON "HieImagingSeries"("clinicId", "id");
CREATE INDEX "HieImagingInstance_clinicId_seriesId_idx" ON "HieImagingInstance"("clinicId", "seriesId");
CREATE UNIQUE INDEX "HieImagingInstance_clinicId_sopUid_key" ON "HieImagingInstance"("clinicId", "sopUid");
CREATE UNIQUE INDEX "HieImagingInstance_clinicId_id_key" ON "HieImagingInstance"("clinicId", "id");
CREATE INDEX "HieEmergencyAccess_clinicId_reviewStatus_effectiveTo_idx" ON "HieEmergencyAccess"("clinicId", "reviewStatus", "effectiveTo");
CREATE INDEX "HieEmergencyAccess_clinicId_patientId_effectiveTo_idx" ON "HieEmergencyAccess"("clinicId", "patientId", "effectiveTo");
CREATE UNIQUE INDEX "HieEmergencyAccess_clinicId_id_key" ON "HieEmergencyAccess"("clinicId", "id");
CREATE INDEX "HieDobDiscrepancy_clinicId_status_createdAt_idx" ON "HieDobDiscrepancy"("clinicId", "status", "createdAt");
CREATE UNIQUE INDEX "HieDobDiscrepancy_clinicId_patientId_identityId_key" ON "HieDobDiscrepancy"("clinicId", "patientId", "identityId");

ALTER TABLE "PatientInsuranceExternalIdentity" ADD CONSTRAINT "PatientInsuranceExternalIdentity_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PatientInsuranceExternalIdentity" ADD CONSTRAINT "PatientInsuranceExternalIdentity_patientInsuranceId_fkey" FOREIGN KEY ("patientInsuranceId") REFERENCES "PatientInsurance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieClinicalConcept" ADD CONSTRAINT "HieClinicalConcept_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HieConsultationObservation" ADD CONSTRAINT "HieConsultationObservation_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieConsultationObservation" ADD CONSTRAINT "HieConsultationObservation_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieConsultationObservation" ADD CONSTRAINT "HieConsultationObservation_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieConsultationObservation" ADD CONSTRAINT "HieConsultationObservation_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "HieClinicalConcept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HieStructuredAllergy" ADD CONSTRAINT "HieStructuredAllergy_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieStructuredAllergy" ADD CONSTRAINT "HieStructuredAllergy_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieStructuredAllergy" ADD CONSTRAINT "HieStructuredAllergy_allergenConceptId_fkey" FOREIGN KEY ("allergenConceptId") REFERENCES "HieClinicalConcept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HieImmunization" ADD CONSTRAINT "HieImmunization_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieImmunization" ADD CONSTRAINT "HieImmunization_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieImmunization" ADD CONSTRAINT "HieImmunization_vaccineConceptId_fkey" FOREIGN KEY ("vaccineConceptId") REFERENCES "HieClinicalConcept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HieImagingOrder" ADD CONSTRAINT "HieImagingOrder_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieImagingOrder" ADD CONSTRAINT "HieImagingOrder_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieImagingOrder" ADD CONSTRAINT "HieImagingOrder_procedureConceptId_fkey" FOREIGN KEY ("procedureConceptId") REFERENCES "HieClinicalConcept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HieImagingOrder" ADD CONSTRAINT "HieImagingOrder_reasonConceptId_fkey" FOREIGN KEY ("reasonConceptId") REFERENCES "HieClinicalConcept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HieImagingStudy" ADD CONSTRAINT "HieImagingStudy_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieImagingStudy" ADD CONSTRAINT "HieImagingStudy_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieImagingStudy" ADD CONSTRAINT "HieImagingStudy_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "HieImagingOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HieImagingStudy" ADD CONSTRAINT "HieImagingStudy_procedureConceptId_fkey" FOREIGN KEY ("procedureConceptId") REFERENCES "HieClinicalConcept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HieImagingStudy" ADD CONSTRAINT "HieImagingStudy_reasonConceptId_fkey" FOREIGN KEY ("reasonConceptId") REFERENCES "HieClinicalConcept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HieImagingSeries" ADD CONSTRAINT "HieImagingSeries_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "HieImagingStudy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieImagingSeries" ADD CONSTRAINT "HieImagingSeries_bodySiteConceptId_fkey" FOREIGN KEY ("bodySiteConceptId") REFERENCES "HieClinicalConcept"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HieImagingInstance" ADD CONSTRAINT "HieImagingInstance_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "HieImagingSeries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieEmergencyAccess" ADD CONSTRAINT "HieEmergencyAccess_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieEmergencyAccess" ADD CONSTRAINT "HieEmergencyAccess_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieDobDiscrepancy" ADD CONSTRAINT "HieDobDiscrepancy_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieDobDiscrepancy" ADD CONSTRAINT "HieDobDiscrepancy_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieDobDiscrepancy" ADD CONSTRAINT "HieDobDiscrepancy_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "PatientExternalIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
