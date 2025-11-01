-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "convertedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Clinic_convertedAt_idx" ON "Clinic"("convertedAt");
