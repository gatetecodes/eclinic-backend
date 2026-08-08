CREATE TYPE "HieEnvironment" AS ENUM ('TEST', 'PRODUCTION');
CREATE TYPE "HieVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'CONFLICT', 'REVOKED');
CREATE TYPE "HieConsentStatus" AS ENUM ('DRAFT', 'ACTIVE', 'REJECTED', 'INACTIVE');
CREATE TYPE "HieOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'RETRY', 'BLOCKED', 'SUCCEEDED', 'DEAD_LETTER');
CREATE TYPE "HieReconciliationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DISMISSED');
CREATE TYPE "HieTransferStatus" AS ENUM ('DRAFT', 'QUEUED', 'SENT', 'ACKNOWLEDGED', 'FAILED', 'CANCELLED', 'COMPLETED');

ALTER TABLE "Product" ADD COLUMN "snomedCode" TEXT;
ALTER TABLE "Product" ADD COLUMN "ichiCode" TEXT;

CREATE TABLE "HieTenantConfig" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "environment" "HieEnvironment" NOT NULL DEFAULT 'TEST',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "clientRegistryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "sharedRecordReadEnabled" BOOLEAN NOT NULL DEFAULT false,
    "sharedRecordWriteEnabled" BOOLEAN NOT NULL DEFAULT false,
    "transferEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastHealthStatus" TEXT,
    "lastHealthCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HieTenantConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HieFacilityLink" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "fosaCode" TEXT NOT NULL,
    "locationReference" TEXT NOT NULL,
    "displayName" TEXT,
    "verificationStatus" "HieVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedAt" TIMESTAMP(3),
    "lastRegistryCheckAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HieFacilityLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PatientExternalIdentity" (
    "id" SERIAL NOT NULL,
    "patientId" INTEGER NOT NULL,
    "identifierType" TEXT NOT NULL,
    "identifierHash" TEXT NOT NULL,
    "identifierEncrypted" TEXT NOT NULL,
    "resourceIdHash" TEXT,
    "resourceIdEncrypted" TEXT,
    "source" TEXT NOT NULL DEFAULT 'RHIE_CLIENT_REGISTRY',
    "verificationStatus" "HieVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedAt" TIMESTAMP(3),
    "deferredReason" TEXT,
    "demographicsSnapshotEncrypted" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PatientExternalIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserExternalIdentity" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "identifierType" TEXT NOT NULL DEFAULT 'PRACTITIONER',
    "identifierHash" TEXT NOT NULL,
    "identifierEncrypted" TEXT NOT NULL,
    "verificationStatus" "HieVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserExternalIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HieConsent" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "patientId" INTEGER NOT NULL,
    "status" "HieConsentStatus" NOT NULL DEFAULT 'DRAFT',
    "scope" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "evidence" JSONB,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "recordedById" INTEGER NOT NULL,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnReason" TEXT,
    "hieResourceIdEncrypted" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HieConsent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HieResourceLink" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "localResourceType" TEXT NOT NULL,
    "localResourceId" TEXT NOT NULL,
    "hieResourceType" TEXT NOT NULL,
    "hieResourceIdHash" TEXT NOT NULL,
    "hieResourceIdEncrypted" TEXT NOT NULL,
    "versionId" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HieResourceLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HieOutboxEvent" (
    "id" TEXT NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "payloadEncrypted" TEXT NOT NULL,
    "status" "HieOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "dependencyReason" TEXT,
    "dependencyOrder" INTEGER NOT NULL DEFAULT 0,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlationId" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HieOutboxEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HieSyncAttempt" (
    "id" SERIAL NOT NULL,
    "eventId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "httpStatus" INTEGER,
    "outcome" TEXT NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HieSyncAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HieAuditEvent" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "patientId" INTEGER,
    "actorId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "purposeOfUse" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HieAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HieReconciliation" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "patientId" INTEGER NOT NULL,
    "externalResourceType" TEXT NOT NULL,
    "externalResourceIdHash" TEXT NOT NULL,
    "externalResourceIdEncrypted" TEXT NOT NULL,
    "status" "HieReconciliationStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "notes" TEXT,
    "localResourceType" TEXT,
    "localResourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HieReconciliation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HieExternalTransfer" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "sourceBranchId" INTEGER NOT NULL,
    "visitId" INTEGER NOT NULL,
    "patientId" INTEGER NOT NULL,
    "referringPractitionerId" INTEGER NOT NULL,
    "destinationFosaCode" TEXT NOT NULL,
    "destinationLocationReference" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "urgency" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "clinicalSummary" TEXT NOT NULL,
    "status" "HieTransferStatus" NOT NULL DEFAULT 'DRAFT',
    "acknowledgement" TEXT,
    "hieEncounterIdEncrypted" TEXT,
    "sentAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HieExternalTransfer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HieTenantConfig_clinicId_key" ON "HieTenantConfig"("clinicId");
CREATE UNIQUE INDEX "HieFacilityLink_clinicId_branchId_key" ON "HieFacilityLink"("clinicId", "branchId");
CREATE UNIQUE INDEX "HieFacilityLink_fosaCode_key" ON "HieFacilityLink"("fosaCode");
CREATE INDEX "HieFacilityLink_locationReference_idx" ON "HieFacilityLink"("locationReference");
CREATE UNIQUE INDEX "PatientExternalIdentity_identifierType_identifierHash_key" ON "PatientExternalIdentity"("identifierType", "identifierHash");
CREATE INDEX "PatientExternalIdentity_patientId_verificationStatus_idx" ON "PatientExternalIdentity"("patientId", "verificationStatus");
CREATE INDEX "PatientExternalIdentity_resourceIdHash_idx" ON "PatientExternalIdentity"("resourceIdHash");
CREATE UNIQUE INDEX "UserExternalIdentity_identifierType_identifierHash_key" ON "UserExternalIdentity"("identifierType", "identifierHash");
CREATE INDEX "UserExternalIdentity_userId_verificationStatus_idx" ON "UserExternalIdentity"("userId", "verificationStatus");
CREATE INDEX "HieConsent_clinicId_patientId_status_idx" ON "HieConsent"("clinicId", "patientId", "status");
CREATE UNIQUE INDEX "HieResourceLink_local_key" ON "HieResourceLink"("clinicId", "localResourceType", "localResourceId", "hieResourceType");
CREATE UNIQUE INDEX "HieResourceLink_hie_key" ON "HieResourceLink"("hieResourceType", "hieResourceIdHash");
CREATE UNIQUE INDEX "HieOutboxEvent_correlationId_key" ON "HieOutboxEvent"("correlationId");
CREATE INDEX "HieOutboxEvent_status_nextAttemptAt_dependencyOrder_idx" ON "HieOutboxEvent"("status", "nextAttemptAt", "dependencyOrder");
CREATE INDEX "HieOutboxEvent_clinicId_aggregateType_aggregateId_idx" ON "HieOutboxEvent"("clinicId", "aggregateType", "aggregateId");
CREATE INDEX "HieSyncAttempt_eventId_attemptNumber_idx" ON "HieSyncAttempt"("eventId", "attemptNumber");
CREATE INDEX "HieAuditEvent_clinicId_createdAt_idx" ON "HieAuditEvent"("clinicId", "createdAt");
CREATE INDEX "HieAuditEvent_patientId_createdAt_idx" ON "HieAuditEvent"("patientId", "createdAt");
CREATE INDEX "HieAuditEvent_correlationId_idx" ON "HieAuditEvent"("correlationId");
CREATE UNIQUE INDEX "HieReconciliation_source_key" ON "HieReconciliation"("clinicId", "patientId", "externalResourceType", "externalResourceIdHash");
CREATE INDEX "HieReconciliation_patientId_status_idx" ON "HieReconciliation"("patientId", "status");
CREATE INDEX "HieExternalTransfer_clinicId_status_idx" ON "HieExternalTransfer"("clinicId", "status");
CREATE INDEX "HieExternalTransfer_patientId_createdAt_idx" ON "HieExternalTransfer"("patientId", "createdAt");
CREATE INDEX "HieExternalTransfer_visitId_idx" ON "HieExternalTransfer"("visitId");
CREATE INDEX "Product_snomedCode_idx" ON "Product"("snomedCode");
CREATE INDEX "Product_ichiCode_idx" ON "Product"("ichiCode");

ALTER TABLE "HieTenantConfig" ADD CONSTRAINT "HieTenantConfig_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieFacilityLink" ADD CONSTRAINT "HieFacilityLink_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieFacilityLink" ADD CONSTRAINT "HieFacilityLink_branchId_clinicId_fkey" FOREIGN KEY ("branchId", "clinicId") REFERENCES "Branch"("id", "clinicId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PatientExternalIdentity" ADD CONSTRAINT "PatientExternalIdentity_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserExternalIdentity" ADD CONSTRAINT "UserExternalIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieConsent" ADD CONSTRAINT "HieConsent_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieConsent" ADD CONSTRAINT "HieConsent_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieConsent" ADD CONSTRAINT "HieConsent_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HieResourceLink" ADD CONSTRAINT "HieResourceLink_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieOutboxEvent" ADD CONSTRAINT "HieOutboxEvent_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieSyncAttempt" ADD CONSTRAINT "HieSyncAttempt_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "HieOutboxEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieAuditEvent" ADD CONSTRAINT "HieAuditEvent_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieAuditEvent" ADD CONSTRAINT "HieAuditEvent_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HieAuditEvent" ADD CONSTRAINT "HieAuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HieReconciliation" ADD CONSTRAINT "HieReconciliation_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieReconciliation" ADD CONSTRAINT "HieReconciliation_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieReconciliation" ADD CONSTRAINT "HieReconciliation_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HieExternalTransfer" ADD CONSTRAINT "HieExternalTransfer_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieExternalTransfer" ADD CONSTRAINT "HieExternalTransfer_sourceBranchId_clinicId_fkey" FOREIGN KEY ("sourceBranchId", "clinicId") REFERENCES "Branch"("id", "clinicId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HieExternalTransfer" ADD CONSTRAINT "HieExternalTransfer_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HieExternalTransfer" ADD CONSTRAINT "HieExternalTransfer_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HieExternalTransfer" ADD CONSTRAINT "HieExternalTransfer_referringPractitionerId_fkey" FOREIGN KEY ("referringPractitionerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
