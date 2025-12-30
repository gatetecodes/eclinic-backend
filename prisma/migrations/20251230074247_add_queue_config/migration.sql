/*
  Warnings:

  - Added the required column `name` to the `Queue` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Queue" DROP CONSTRAINT "Queue_departmentId_fkey";

-- DropIndex
DROP INDEX "Queue_clinicId_branchId_departmentId_doctorId_idx";

-- DropIndex
DROP INDEX "Queue_clinicId_branchId_departmentId_doctorId_status_key";

-- AlterTable
ALTER TABLE "Queue" ADD COLUMN     "name" TEXT NOT NULL,
ADD COLUMN     "queueConfigId" INTEGER,
ALTER COLUMN "departmentId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "QueueEntry" ADD COLUMN     "checkInTime" TIMESTAMP(3),
ADD COLUMN     "estimatedWaitTime" INTEGER;

-- CreateTable
CREATE TABLE "QueueConfig" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "departmentId" INTEGER,
    "doctorId" INTEGER,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "slug" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "autoOpenTime" TEXT,
    "autoCloseTime" TEXT,
    "isAutoOpenEnabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultAvgTime" INTEGER NOT NULL DEFAULT 10,
    "maxCapacity" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QueueConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QueueConfig_slug_key" ON "QueueConfig"("slug");

-- CreateIndex
CREATE INDEX "QueueConfig_clinicId_branchId_idx" ON "QueueConfig"("clinicId", "branchId");

-- CreateIndex
CREATE INDEX "QueueConfig_slug_idx" ON "QueueConfig"("slug");

-- CreateIndex
CREATE INDEX "Queue_clinicId_branchId_idx" ON "Queue"("clinicId", "branchId");

-- CreateIndex
CREATE INDEX "Queue_queueConfigId_idx" ON "Queue"("queueConfigId");

-- CreateIndex
CREATE INDEX "Queue_status_idx" ON "Queue"("status");

-- AddForeignKey
ALTER TABLE "QueueConfig" ADD CONSTRAINT "QueueConfig_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueConfig" ADD CONSTRAINT "QueueConfig_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueConfig" ADD CONSTRAINT "QueueConfig_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "ClinicalDepartment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueConfig" ADD CONSTRAINT "QueueConfig_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Queue" ADD CONSTRAINT "Queue_queueConfigId_fkey" FOREIGN KEY ("queueConfigId") REFERENCES "QueueConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Queue" ADD CONSTRAINT "Queue_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "ClinicalDepartment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
