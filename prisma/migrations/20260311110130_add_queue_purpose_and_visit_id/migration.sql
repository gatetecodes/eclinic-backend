-- CreateEnum
CREATE TYPE "QueuePurpose" AS ENUM ('DOCTOR', 'PRE_CONSULTATION', 'LAB', 'CASHIER', 'RECEPTION');

-- AlterTable
ALTER TABLE "QueueConfig" ADD COLUMN     "purpose" "QueuePurpose";

-- AlterTable
ALTER TABLE "QueueEntry" ADD COLUMN     "visitId" INTEGER;

-- CreateIndex
CREATE INDEX "QueueEntry_visitId_idx" ON "QueueEntry"("visitId");

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
