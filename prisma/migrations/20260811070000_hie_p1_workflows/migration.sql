-- Identity verification retry and reconciliation workflows.
ALTER TABLE "PatientExternalIdentity"
ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "nextRetryAt" TIMESTAMP(3),
ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN "lastErrorCode" TEXT;

CREATE TYPE "HieIdentityCaseStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');
CREATE TYPE "HieInboundTransferStatus" AS ENUM ('RECEIVED', 'REVIEWED', 'ACKNOWLEDGED', 'COMPLETED', 'DISMISSED');

CREATE TABLE "HieIdentityReconciliation" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "patientId" INTEGER NOT NULL,
    "conflictingPatientId" INTEGER,
    "identifierType" TEXT NOT NULL,
    "identifierHash" TEXT NOT NULL,
    "identifierEncrypted" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "status" "HieIdentityCaseStatus" NOT NULL DEFAULT 'OPEN',
    "snapshotEncrypted" TEXT,
    "resolvedById" INTEGER,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HieIdentityReconciliation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HieIdentityReconciliation_clinicId_status_createdAt_idx" ON "HieIdentityReconciliation"("clinicId", "status", "createdAt");
CREATE INDEX "HieIdentityReconciliation_patientId_status_idx" ON "HieIdentityReconciliation"("patientId", "status");
CREATE INDEX "HieIdentityReconciliation_identifierHash_idx" ON "HieIdentityReconciliation"("identifierHash");

ALTER TABLE "HieIdentityReconciliation" ADD CONSTRAINT "HieIdentityReconciliation_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieIdentityReconciliation" ADD CONSTRAINT "HieIdentityReconciliation_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieIdentityReconciliation" ADD CONSTRAINT "HieIdentityReconciliation_conflictingPatientId_fkey" FOREIGN KEY ("conflictingPatientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HieIdentityReconciliation" ADD CONSTRAINT "HieIdentityReconciliation_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Explicit inventory-to-national-product linkage for medication publication.
ALTER TABLE "InventoryItem" ADD COLUMN "productId" INTEGER;
CREATE INDEX "InventoryItem_productId_idx" ON "InventoryItem"("productId");
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Inbound national transfers remain separate from local visits until reviewed.
CREATE TABLE "HieInboundTransfer" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "patientId" INTEGER NOT NULL,
    "externalEncounterIdHash" TEXT NOT NULL,
    "externalEncounterIdEncrypted" TEXT NOT NULL,
    "sourceFacilityReference" TEXT,
    "sourceFacilityDisplay" TEXT,
    "referringPractitionerDisplay" TEXT,
    "reason" TEXT,
    "clinicalDate" TIMESTAMP(3),
    "status" "HieInboundTransferStatus" NOT NULL DEFAULT 'RECEIVED',
    "reviewedById" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "acknowledgement" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "payloadEncrypted" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HieInboundTransfer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HieInboundTransfer_clinicId_externalEncounterIdHash_key" ON "HieInboundTransfer"("clinicId", "externalEncounterIdHash");
CREATE INDEX "HieInboundTransfer_clinicId_status_createdAt_idx" ON "HieInboundTransfer"("clinicId", "status", "createdAt");
CREATE INDEX "HieInboundTransfer_patientId_status_idx" ON "HieInboundTransfer"("patientId", "status");
ALTER TABLE "HieInboundTransfer" ADD CONSTRAINT "HieInboundTransfer_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieInboundTransfer" ADD CONSTRAINT "HieInboundTransfer_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HieInboundTransfer" ADD CONSTRAINT "HieInboundTransfer_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
