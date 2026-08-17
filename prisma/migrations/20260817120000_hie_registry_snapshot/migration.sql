-- National registry snapshot + registry-granted verification.
--
-- Facility mapping was manual data entry plus a self-attestation: an admin typed
-- a FOSA code and a Location/… reference and chose their own verification
-- status. Nothing in the codebase ever contacted a registry, so the VERIFIED
-- status that the transfer and UPID gates required could never be granted.
--
-- HieFacilityDirectory holds the national facility list so the admin console can
-- pick a facility instead of typing references, and so verification can be
-- decided server-side against an authoritative source. National public reference
-- data, deliberately not tenant-scoped — the same shape as HieClinicalConcept.
-- It is keyed by environment because a TEST snapshot must never be the basis on
-- which a PRODUCTION mapping is marked VERIFIED.
--
-- HieRegistrySyncRun records each sync attempt. HieAuditEvent cannot be used:
-- it requires a clinicId and an actorId, so it has no way to record a cron run.
--
-- lastRegistryCheckAt is added to the two identity tables that lacked it so
-- "checked, mismatched, and deliberately not downgraded" is recordable, and so
-- the console can show a last-checked time for all three mapping kinds.

CREATE TABLE "HieFacilityDirectory" (
    "id" SERIAL NOT NULL,
    "environment" "HieEnvironment" NOT NULL,
    "fosaCode" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "locationReference" TEXT,
    "organizationReference" TEXT,
    "name" TEXT NOT NULL,
    "facilityType" TEXT,
    "province" TEXT,
    "district" TEXT,
    "identifierSystem" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "registrySyncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HieFacilityDirectory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HieFacilityDirectory_environment_fosaCode_key" ON "HieFacilityDirectory"("environment", "fosaCode");

CREATE UNIQUE INDEX "HieFacilityDirectory_environment_resourceType_resourceId_key" ON "HieFacilityDirectory"("environment", "resourceType", "resourceId");

CREATE INDEX "HieFacilityDirectory_environment_active_name_idx" ON "HieFacilityDirectory"("environment", "active", "name");

CREATE INDEX "HieFacilityDirectory_environment_active_district_idx" ON "HieFacilityDirectory"("environment", "active", "district");

CREATE TABLE "HieRegistrySyncRun" (
    "id" SERIAL NOT NULL,
    "registry" TEXT NOT NULL,
    "environment" "HieEnvironment" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "outcome" TEXT NOT NULL,
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "correlationId" TEXT NOT NULL,

    CONSTRAINT "HieRegistrySyncRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HieRegistrySyncRun_registry_environment_startedAt_idx" ON "HieRegistrySyncRun"("registry", "environment", "startedAt");

ALTER TABLE "HieDestinationFacility" ADD COLUMN "lastRegistryCheckAt" TIMESTAMP(3);

ALTER TABLE "UserExternalIdentity" ADD COLUMN "lastRegistryCheckAt" TIMESTAMP(3);
