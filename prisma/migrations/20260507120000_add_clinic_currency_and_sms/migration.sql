-- CreateEnum
CREATE TYPE "public"."CurrencyCode" AS ENUM ('RWF', 'USD', 'EUR');

-- CreateEnum
CREATE TYPE "public"."SmsDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."SmsEventType" AS ENUM ('QUEUE_JOINED', 'QUEUE_TURN', 'LAB_RESULTS_READY', 'VISIT_COMPLETED');

-- AlterTable
ALTER TABLE "public"."Clinic"
ADD COLUMN "defaultCurrency" "public"."CurrencyCode" NOT NULL DEFAULT 'RWF',
ADD COLUMN "isSmsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "smsOnQueueJoined" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "smsOnQueueTurn" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "smsOnLabResultsReady" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "smsOnVisitCompletion" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "public"."OutboundSmsLog" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "patientId" INTEGER,
    "visitId" INTEGER,
    "phoneNumber" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "eventType" "public"."SmsEventType" NOT NULL,
    "status" "public"."SmsDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT NOT NULL DEFAULT 'TWILIO',
    "providerMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextRetryAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundSmsLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboundSmsLog_clinicId_eventType_idx" ON "public"."OutboundSmsLog"("clinicId", "eventType");

-- CreateIndex
CREATE INDEX "OutboundSmsLog_status_nextRetryAt_idx" ON "public"."OutboundSmsLog"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "OutboundSmsLog_providerMessageId_idx" ON "public"."OutboundSmsLog"("providerMessageId");

-- CreateIndex
CREATE INDEX "OutboundSmsLog_visitId_idx" ON "public"."OutboundSmsLog"("visitId");

-- CreateIndex
CREATE INDEX "OutboundSmsLog_patientId_idx" ON "public"."OutboundSmsLog"("patientId");

-- AddForeignKey
ALTER TABLE "public"."OutboundSmsLog" ADD CONSTRAINT "OutboundSmsLog_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OutboundSmsLog" ADD CONSTRAINT "OutboundSmsLog_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "public"."Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OutboundSmsLog" ADD CONSTRAINT "OutboundSmsLog_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "public"."Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
