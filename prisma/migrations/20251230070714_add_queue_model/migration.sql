-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('OPEN', 'PAUSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "QueueEntryStatus" AS ENUM ('WAITING', 'NOTIFIED', 'SKIPPED', 'SERVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QueueSource" AS ENUM ('WHATSAPP', 'APP', 'KIOSK', 'STAFF');

-- CreateEnum
CREATE TYPE "QueueEventType" AS ENUM ('JOINED', 'NOTIFIED', 'SKIPPED', 'SERVED', 'CANCELLED', 'DELAYED');

-- CreateTable
CREATE TABLE "Queue" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "departmentId" INTEGER NOT NULL,
    "doctorId" INTEGER,
    "status" "QueueStatus" NOT NULL DEFAULT 'OPEN',
    "avgDepartmentTimeInMinutes" INTEGER NOT NULL DEFAULT 10,
    "startAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closeAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueueEntry" (
    "id" SERIAL NOT NULL,
    "queueId" INTEGER NOT NULL,
    "patientId" INTEGER,
    "phoneNumber" TEXT NOT NULL,
    "name" TEXT,
    "position" INTEGER NOT NULL,
    "status" "QueueEntryStatus" NOT NULL DEFAULT 'WAITING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "servedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "source" "QueueSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QueueEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueueEvent" (
    "id" SERIAL NOT NULL,
    "queueEntryId" INTEGER NOT NULL,
    "type" "QueueEventType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QueueEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Queue_clinicId_branchId_departmentId_doctorId_idx" ON "Queue"("clinicId", "branchId", "departmentId", "doctorId");

-- CreateIndex
CREATE UNIQUE INDEX "Queue_clinicId_branchId_departmentId_doctorId_status_key" ON "Queue"("clinicId", "branchId", "departmentId", "doctorId", "status");

-- CreateIndex
CREATE INDEX "QueueEntry_queueId_idx" ON "QueueEntry"("queueId");

-- CreateIndex
CREATE INDEX "QueueEntry_phoneNumber_idx" ON "QueueEntry"("phoneNumber");

-- CreateIndex
CREATE INDEX "QueueEntry_status_idx" ON "QueueEntry"("status");

-- CreateIndex
CREATE INDEX "QueueEvent_queueEntryId_idx" ON "QueueEvent"("queueEntryId");

-- CreateIndex
CREATE INDEX "QueueEvent_type_idx" ON "QueueEvent"("type");

-- AddForeignKey
ALTER TABLE "Queue" ADD CONSTRAINT "Queue_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Queue" ADD CONSTRAINT "Queue_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Queue" ADD CONSTRAINT "Queue_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "ClinicalDepartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Queue" ADD CONSTRAINT "Queue_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "Queue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueEvent" ADD CONSTRAINT "QueueEvent_queueEntryId_fkey" FOREIGN KEY ("queueEntryId") REFERENCES "QueueEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
