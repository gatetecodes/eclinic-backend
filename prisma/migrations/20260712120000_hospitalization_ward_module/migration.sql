-- Inpatient Ward module: replace Room/RoomPrice with Ward/Bed, enrich the
-- Hospitalization (admission) record, and add the clinical + charge-ledger
-- tables. Existing Rooms are migrated into a per-clinic "General Ward" as Beds
-- and existing Hospitalizations are re-pointed to the corresponding Bed, so no
-- inpatient data is lost.

-- CreateEnum
CREATE TYPE "WardType" AS ENUM ('MEDICAL', 'SURGICAL', 'MATERNITY', 'PAEDIATRIC', 'ICU', 'GENERAL');
CREATE TYPE "BedStatus" AS ENUM ('AVAILABLE', 'OCCUPIED', 'CLEANING', 'OUT_OF_SERVICE');
CREATE TYPE "AdmissionStatus" AS ENUM ('CRITICAL', 'SERIOUS', 'STABLE', 'IMPROVING', 'FOR_DISCHARGE');
CREATE TYPE "AdmissionSource" AS ENUM ('CONSULTATION', 'EMERGENCY', 'TRANSFER_IN');
CREATE TYPE "MedicationRoute" AS ENUM ('IV', 'IM', 'PO', 'SC');
CREATE TYPE "MarStatus" AS ENUM ('GIVEN', 'DUE', 'MISSED', 'NOT_APPLICABLE');
CREATE TYPE "ProgressNoteType" AS ENUM ('WARD_ROUND', 'CONSULTANT_REVIEW', 'ON_CALL_REVIEW', 'PROCEDURE', 'ADMISSION');
CREATE TYPE "DischargeDestination" AS ENUM ('HOME', 'REFERRAL_HOSPITAL', 'HEALTH_CENTRE_FOLLOWUP');
CREATE TYPE "WardChargeCategory" AS ENUM ('BED', 'REVIEW', 'MEDS', 'LAB', 'IMAGING', 'PROCEDURE');
CREATE TYPE "WardOrderCategory" AS ENUM ('LAB', 'IMAGING');
CREATE TYPE "WardOrderStatus" AS ENUM ('ORDERED', 'IN_PROGRESS', 'RESULTED');

-- CreateTable Ward
CREATE TABLE "Ward" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "wardType" "WardType" NOT NULL DEFAULT 'GENERAL',
    "accent" TEXT NOT NULL DEFAULT 'brand',
    "dailyRate" DECIMAL(10,2) NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "branchId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Ward_pkey" PRIMARY KEY ("id")
);

-- CreateTable Bed (with a temporary legacy-room reference used only for the backfill)
CREATE TABLE "Bed" (
    "id" SERIAL NOT NULL,
    "wardId" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "status" "BedStatus" NOT NULL DEFAULT 'AVAILABLE',
    "legacyRoomId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Bed_pkey" PRIMARY KEY ("id")
);

-- Backfill: one General Ward per clinic, priced from any existing RoomPrice (else 15,000).
INSERT INTO "Ward" ("name", "wardType", "accent", "dailyRate", "clinicId", "branchId", "createdAt", "updatedAt")
SELECT 'General Ward', 'GENERAL', 'brand',
       COALESCE((SELECT rp."price" FROM "RoomPrice" rp WHERE rp."clinicId" = c."id" ORDER BY rp."price" DESC LIMIT 1), 15000),
       c."id", NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Clinic" c;

-- Backfill: each existing Room becomes a Bed under its clinic's General Ward.
INSERT INTO "Bed" ("wardId", "number", "label", "status", "legacyRoomId", "createdAt", "updatedAt")
SELECT w."id",
       ROW_NUMBER() OVER (PARTITION BY r."clinicId" ORDER BY r."id"),
       r."number",
       CASE WHEN r."isOccupied" THEN 'OCCUPIED'::"BedStatus" ELSE 'AVAILABLE'::"BedStatus" END,
       r."id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Room" r
JOIN "Ward" w ON w."clinicId" = r."clinicId";

-- AlterTable Hospitalization: add new columns (nullable/defaulted first).
ALTER TABLE "Hospitalization"
    ADD COLUMN "wardId" INTEGER,
    ADD COLUMN "bedId" INTEGER,
    ADD COLUMN "attendingId" INTEGER,
    ADD COLUMN "status" "AdmissionStatus" NOT NULL DEFAULT 'STABLE',
    ADD COLUMN "source" "AdmissionSource" NOT NULL DEFAULT 'CONSULTATION',
    ADD COLUMN "presentingComplaint" TEXT,
    ADD COLUMN "admittingDiagnosis" TEXT,
    ADD COLUMN "admittingIcdCode" TEXT,
    ADD COLUMN "estimatedStayDays" INTEGER;

-- Backfill: re-point existing admissions to their migrated bed/ward.
UPDATE "Hospitalization" h
SET "bedId" = b."id", "wardId" = b."wardId"
FROM "Bed" b
WHERE b."legacyRoomId" = h."roomId";

-- Now enforce NOT NULL on the location columns.
ALTER TABLE "Hospitalization" ALTER COLUMN "wardId" SET NOT NULL;
ALTER TABLE "Hospitalization" ALTER COLUMN "bedId" SET NOT NULL;

-- Drop the old room linkage and the temporary backfill column.
ALTER TABLE "Hospitalization" DROP CONSTRAINT "Hospitalization_roomId_fkey";
DROP INDEX "Hospitalization_roomId_idx";
ALTER TABLE "Hospitalization" DROP COLUMN "roomId";
ALTER TABLE "Bed" DROP COLUMN "legacyRoomId";

-- Drop the retired Room/RoomPrice model.
ALTER TABLE "RoomPrice" DROP CONSTRAINT "RoomPrice_clinicId_fkey";
ALTER TABLE "RoomPrice" DROP CONSTRAINT "RoomPrice_branchId_fkey";
ALTER TABLE "Room" DROP CONSTRAINT "Room_clinicId_fkey";
ALTER TABLE "Room" DROP CONSTRAINT "Room_branchId_fkey";
DROP TABLE "RoomPrice";
DROP TABLE "Room";
DROP TYPE "RoomClass";

-- CreateTable WardObservation
CREATE TABLE "WardObservation" (
    "id" SERIAL NOT NULL,
    "hospitalizationId" INTEGER NOT NULL,
    "temperature" TEXT,
    "heartRate" TEXT,
    "bloodPressure" TEXT,
    "respiratoryRate" TEXT,
    "spo2" TEXT,
    "pain" INTEGER,
    "avpu" TEXT,
    "ewsScore" INTEGER NOT NULL DEFAULT 0,
    "recordedById" INTEGER,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WardObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable WardMedication
CREATE TABLE "WardMedication" (
    "id" SERIAL NOT NULL,
    "hospitalizationId" INTEGER NOT NULL,
    "productId" INTEGER,
    "drugName" TEXT NOT NULL,
    "dose" TEXT NOT NULL,
    "route" "MedicationRoute" NOT NULL,
    "frequency" TEXT NOT NULL,
    "firstDoseAt" TIMESTAMP(3),
    "pricePerDose" DECIMAL(10,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "prescribedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WardMedication_pkey" PRIMARY KEY ("id")
);

-- CreateTable WardMedicationAdministration
CREATE TABLE "WardMedicationAdministration" (
    "id" SERIAL NOT NULL,
    "wardMedicationId" INTEGER NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" "MarStatus" NOT NULL DEFAULT 'DUE',
    "administeredById" INTEGER,
    "administeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WardMedicationAdministration_pkey" PRIMARY KEY ("id")
);

-- CreateTable ProgressNote
CREATE TABLE "ProgressNote" (
    "id" SERIAL NOT NULL,
    "hospitalizationId" INTEGER NOT NULL,
    "authorId" INTEGER,
    "noteType" "ProgressNoteType" NOT NULL DEFAULT 'WARD_ROUND',
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProgressNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable BedTransfer
CREATE TABLE "BedTransfer" (
    "id" SERIAL NOT NULL,
    "hospitalizationId" INTEGER NOT NULL,
    "fromBedId" INTEGER,
    "toBedId" INTEGER NOT NULL,
    "reason" TEXT,
    "transferredById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BedTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable DischargeSummary
CREATE TABLE "DischargeSummary" (
    "id" SERIAL NOT NULL,
    "hospitalizationId" INTEGER NOT NULL,
    "finalDiagnosis" TEXT,
    "summary" TEXT,
    "followUpDate" TIMESTAMP(3),
    "destination" "DischargeDestination" NOT NULL DEFAULT 'HOME',
    "patientInstructions" TEXT,
    "dischargedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DischargeSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable WardCharge
CREATE TABLE "WardCharge" (
    "id" SERIAL NOT NULL,
    "hospitalizationId" INTEGER NOT NULL,
    "category" "WardChargeCategory" NOT NULL,
    "label" TEXT NOT NULL,
    "detail" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WardCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable WardOrder
CREATE TABLE "WardOrder" (
    "id" SERIAL NOT NULL,
    "hospitalizationId" INTEGER NOT NULL,
    "investigation" TEXT NOT NULL,
    "category" "WardOrderCategory" NOT NULL DEFAULT 'LAB',
    "status" "WardOrderStatus" NOT NULL DEFAULT 'ORDERED',
    "result" TEXT,
    "resultSeverity" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "orderedById" INTEGER,
    "orderedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resultedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WardOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WardOrder_hospitalizationId_idx" ON "WardOrder"("hospitalizationId");
CREATE INDEX "WardOrder_orderedById_idx" ON "WardOrder"("orderedById");

-- CreateIndex
CREATE INDEX "Ward_clinicId_idx" ON "Ward"("clinicId");
CREATE INDEX "Ward_branchId_idx" ON "Ward"("branchId");
CREATE INDEX "Bed_wardId_idx" ON "Bed"("wardId");
CREATE UNIQUE INDEX "Bed_wardId_number_key" ON "Bed"("wardId", "number");
CREATE INDEX "WardObservation_hospitalizationId_idx" ON "WardObservation"("hospitalizationId");
CREATE INDEX "WardObservation_recordedById_idx" ON "WardObservation"("recordedById");
CREATE INDEX "WardMedication_hospitalizationId_idx" ON "WardMedication"("hospitalizationId");
CREATE INDEX "WardMedication_productId_idx" ON "WardMedication"("productId");
CREATE INDEX "WardMedicationAdministration_wardMedicationId_idx" ON "WardMedicationAdministration"("wardMedicationId");
CREATE INDEX "WardMedicationAdministration_administeredById_idx" ON "WardMedicationAdministration"("administeredById");
CREATE INDEX "ProgressNote_hospitalizationId_idx" ON "ProgressNote"("hospitalizationId");
CREATE INDEX "ProgressNote_authorId_idx" ON "ProgressNote"("authorId");
CREATE INDEX "BedTransfer_hospitalizationId_idx" ON "BedTransfer"("hospitalizationId");
CREATE UNIQUE INDEX "DischargeSummary_hospitalizationId_key" ON "DischargeSummary"("hospitalizationId");
CREATE INDEX "DischargeSummary_hospitalizationId_idx" ON "DischargeSummary"("hospitalizationId");
CREATE INDEX "WardCharge_hospitalizationId_idx" ON "WardCharge"("hospitalizationId");
CREATE INDEX "WardCharge_category_idx" ON "WardCharge"("category");
CREATE INDEX "Hospitalization_wardId_idx" ON "Hospitalization"("wardId");
CREATE INDEX "Hospitalization_bedId_idx" ON "Hospitalization"("bedId");
CREATE INDEX "Hospitalization_status_idx" ON "Hospitalization"("status");

-- AddForeignKey
ALTER TABLE "Ward" ADD CONSTRAINT "Ward_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ward" ADD CONSTRAINT "Ward_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Bed" ADD CONSTRAINT "Bed_wardId_fkey" FOREIGN KEY ("wardId") REFERENCES "Ward"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Hospitalization" ADD CONSTRAINT "Hospitalization_wardId_fkey" FOREIGN KEY ("wardId") REFERENCES "Ward"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Hospitalization" ADD CONSTRAINT "Hospitalization_bedId_fkey" FOREIGN KEY ("bedId") REFERENCES "Bed"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Hospitalization" ADD CONSTRAINT "Hospitalization_attendingId_fkey" FOREIGN KEY ("attendingId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WardObservation" ADD CONSTRAINT "WardObservation_hospitalizationId_fkey" FOREIGN KEY ("hospitalizationId") REFERENCES "Hospitalization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WardObservation" ADD CONSTRAINT "WardObservation_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WardMedication" ADD CONSTRAINT "WardMedication_hospitalizationId_fkey" FOREIGN KEY ("hospitalizationId") REFERENCES "Hospitalization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WardMedication" ADD CONSTRAINT "WardMedication_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WardMedication" ADD CONSTRAINT "WardMedication_prescribedById_fkey" FOREIGN KEY ("prescribedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WardMedicationAdministration" ADD CONSTRAINT "WardMedicationAdministration_wardMedicationId_fkey" FOREIGN KEY ("wardMedicationId") REFERENCES "WardMedication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WardMedicationAdministration" ADD CONSTRAINT "WardMedicationAdministration_administeredById_fkey" FOREIGN KEY ("administeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProgressNote" ADD CONSTRAINT "ProgressNote_hospitalizationId_fkey" FOREIGN KEY ("hospitalizationId") REFERENCES "Hospitalization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProgressNote" ADD CONSTRAINT "ProgressNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BedTransfer" ADD CONSTRAINT "BedTransfer_hospitalizationId_fkey" FOREIGN KEY ("hospitalizationId") REFERENCES "Hospitalization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BedTransfer" ADD CONSTRAINT "BedTransfer_transferredById_fkey" FOREIGN KEY ("transferredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DischargeSummary" ADD CONSTRAINT "DischargeSummary_hospitalizationId_fkey" FOREIGN KEY ("hospitalizationId") REFERENCES "Hospitalization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DischargeSummary" ADD CONSTRAINT "DischargeSummary_dischargedById_fkey" FOREIGN KEY ("dischargedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WardCharge" ADD CONSTRAINT "WardCharge_hospitalizationId_fkey" FOREIGN KEY ("hospitalizationId") REFERENCES "Hospitalization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WardOrder" ADD CONSTRAINT "WardOrder_hospitalizationId_fkey" FOREIGN KEY ("hospitalizationId") REFERENCES "Hospitalization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WardOrder" ADD CONSTRAINT "WardOrder_orderedById_fkey" FOREIGN KEY ("orderedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
