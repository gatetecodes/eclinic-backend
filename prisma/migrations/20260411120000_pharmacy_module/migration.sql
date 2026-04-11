-- CreateEnum
CREATE TYPE "public"."DispenseOrderSource" AS ENUM ('CLINIC_PRESCRIPTION', 'WALK_IN_OTC', 'EXTERNAL_RX');

-- AlterEnum
ALTER TYPE "public"."SourceType" ADD VALUE 'PHARMACY_DISPENSE';

-- AlterTable
ALTER TABLE "public"."Transaction" ADD COLUMN "dispenseOrderId" TEXT;

-- CreateTable
CREATE TABLE "public"."PharmacyDispenseOrder" (
    "id" TEXT NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "branchId" INTEGER,
    "prescriptionId" INTEGER,
    "visitId" INTEGER,
    "patientId" INTEGER,
    "source" "public"."DispenseOrderSource" NOT NULL,
    "externalPrescriberName" TEXT,
    "externalPrescriptionDate" TIMESTAMP(3),
    "notes" TEXT,
    "performedByUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PharmacyDispenseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PharmacyPrescriptionItemMap" (
    "id" SERIAL NOT NULL,
    "prescriptionItemId" INTEGER NOT NULL,
    "inventoryItemId" INTEGER NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PharmacyPrescriptionItemMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PharmacyIdempotencyRecord" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PharmacyIdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PharmacyDispenseLine" (
    "id" SERIAL NOT NULL,
    "orderId" TEXT NOT NULL,
    "prescriptionItemId" INTEGER,
    "inventoryItemId" INTEGER NOT NULL,
    "batchId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "transactionId" INTEGER NOT NULL,

    CONSTRAINT "PharmacyDispenseLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PharmacyDispenseOrder_clinicId_idx" ON "public"."PharmacyDispenseOrder"("clinicId");

-- CreateIndex
CREATE INDEX "PharmacyDispenseOrder_clinicId_branchId_idx" ON "public"."PharmacyDispenseOrder"("clinicId", "branchId");

-- CreateIndex
CREATE INDEX "PharmacyDispenseOrder_prescriptionId_idx" ON "public"."PharmacyDispenseOrder"("prescriptionId");

-- CreateIndex
CREATE INDEX "PharmacyDispenseOrder_visitId_idx" ON "public"."PharmacyDispenseOrder"("visitId");

-- CreateIndex
CREATE INDEX "PharmacyDispenseOrder_patientId_idx" ON "public"."PharmacyDispenseOrder"("patientId");

-- CreateIndex
CREATE INDEX "PharmacyDispenseOrder_createdAt_idx" ON "public"."PharmacyDispenseOrder"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PharmacyPrescriptionItemMap_prescriptionItemId_key" ON "public"."PharmacyPrescriptionItemMap"("prescriptionItemId");

-- CreateIndex
CREATE INDEX "PharmacyPrescriptionItemMap_clinicId_idx" ON "public"."PharmacyPrescriptionItemMap"("clinicId");

-- CreateIndex
CREATE UNIQUE INDEX "PharmacyIdempotencyRecord_clinicId_userId_key" ON "public"."PharmacyIdempotencyRecord"("clinicId", "userId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "PharmacyIdempotencyRecord_orderId_key" ON "public"."PharmacyIdempotencyRecord"("orderId");

-- CreateIndex
CREATE INDEX "PharmacyIdempotencyRecord_orderId_idx" ON "public"."PharmacyIdempotencyRecord"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "PharmacyDispenseLine_transactionId_key" ON "public"."PharmacyDispenseLine"("transactionId");

-- CreateIndex
CREATE INDEX "PharmacyDispenseLine_orderId_idx" ON "public"."PharmacyDispenseLine"("orderId");

-- CreateIndex
CREATE INDEX "PharmacyDispenseLine_prescriptionItemId_idx" ON "public"."PharmacyDispenseLine"("prescriptionItemId");

-- CreateIndex
CREATE INDEX "PharmacyDispenseLine_inventoryItemId_idx" ON "public"."PharmacyDispenseLine"("inventoryItemId");

-- CreateIndex
CREATE INDEX "Transaction_dispenseOrderId_idx" ON "public"."Transaction"("dispenseOrderId");

-- AddForeignKey
ALTER TABLE "public"."PharmacyDispenseOrder" ADD CONSTRAINT "PharmacyDispenseOrder_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PharmacyDispenseOrder" ADD CONSTRAINT "PharmacyDispenseOrder_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "public"."Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PharmacyDispenseOrder" ADD CONSTRAINT "PharmacyDispenseOrder_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "public"."Prescription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PharmacyDispenseOrder" ADD CONSTRAINT "PharmacyDispenseOrder_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "public"."Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PharmacyDispenseOrder" ADD CONSTRAINT "PharmacyDispenseOrder_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "public"."Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PharmacyDispenseOrder" ADD CONSTRAINT "PharmacyDispenseOrder_performedByUserId_fkey" FOREIGN KEY ("performedByUserId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PharmacyPrescriptionItemMap" ADD CONSTRAINT "PharmacyPrescriptionItemMap_prescriptionItemId_fkey" FOREIGN KEY ("prescriptionItemId") REFERENCES "public"."PrescriptionItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PharmacyPrescriptionItemMap" ADD CONSTRAINT "PharmacyPrescriptionItemMap_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "public"."InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PharmacyPrescriptionItemMap" ADD CONSTRAINT "PharmacyPrescriptionItemMap_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PharmacyIdempotencyRecord" ADD CONSTRAINT "PharmacyIdempotencyRecord_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PharmacyIdempotencyRecord" ADD CONSTRAINT "PharmacyIdempotencyRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PharmacyIdempotencyRecord" ADD CONSTRAINT "PharmacyIdempotencyRecord_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."PharmacyDispenseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PharmacyDispenseLine" ADD CONSTRAINT "PharmacyDispenseLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."PharmacyDispenseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PharmacyDispenseLine" ADD CONSTRAINT "PharmacyDispenseLine_prescriptionItemId_fkey" FOREIGN KEY ("prescriptionItemId") REFERENCES "public"."PrescriptionItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PharmacyDispenseLine" ADD CONSTRAINT "PharmacyDispenseLine_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "public"."InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PharmacyDispenseLine" ADD CONSTRAINT "PharmacyDispenseLine_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "public"."InventoryBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PharmacyDispenseLine" ADD CONSTRAINT "PharmacyDispenseLine_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "public"."Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Transaction" ADD CONSTRAINT "Transaction_dispenseOrderId_fkey" FOREIGN KEY ("dispenseOrderId") REFERENCES "public"."PharmacyDispenseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
