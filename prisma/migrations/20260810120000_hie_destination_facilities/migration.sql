CREATE TABLE "HieDestinationFacility" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "fosaCode" TEXT NOT NULL,
    "locationReference" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "verificationStatus" "HieVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HieDestinationFacility_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "HieExternalTransfer"
ADD COLUMN "destinationFacilityId" INTEGER;

CREATE UNIQUE INDEX "HieDestinationFacility_clinicId_fosaCode_key"
ON "HieDestinationFacility"("clinicId", "fosaCode");

CREATE UNIQUE INDEX "HieDestinationFacility_clinicId_locationReference_key"
ON "HieDestinationFacility"("clinicId", "locationReference");

CREATE INDEX "HieDestinationFacility_clinicId_verificationStatus_displayName_idx"
ON "HieDestinationFacility"("clinicId", "verificationStatus", "displayName");

CREATE INDEX "HieExternalTransfer_destinationFacilityId_idx"
ON "HieExternalTransfer"("destinationFacilityId");

ALTER TABLE "HieDestinationFacility"
ADD CONSTRAINT "HieDestinationFacility_clinicId_fkey"
FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HieExternalTransfer"
ADD CONSTRAINT "HieExternalTransfer_destinationFacilityId_fkey"
FOREIGN KEY ("destinationFacilityId") REFERENCES "HieDestinationFacility"("id") ON DELETE SET NULL ON UPDATE CASCADE;
