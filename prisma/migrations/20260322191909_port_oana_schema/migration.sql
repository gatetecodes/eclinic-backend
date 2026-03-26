-- CreateEnum
CREATE TYPE "ExamResultStatus" AS ENUM ('COMPLETED', 'NOT_PERFORMED');

-- CreateEnum
CREATE TYPE "ForeignerRegion" AS ENUM ('EAST_AFRICA', 'AFRICA', 'REST_OF_THE_WORLD');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApprovalType" ADD VALUE 'EXAM_EDIT';
ALTER TYPE "ApprovalType" ADD VALUE 'TREATMENT_EDIT';
ALTER TYPE "ApprovalType" ADD VALUE 'EXTRA_INVENTORY';

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'DELETED';

-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "examId" INTEGER,
ADD COLUMN     "payload" JSONB,
ADD COLUMN     "treatmentId" INTEGER;

-- AlterTable
ALTER TABLE "ClinicProductPrice" ADD COLUMN     "africaPrice" DECIMAL(10,2),
ADD COLUMN     "eastAfricaPrice" DECIMAL(10,2),
ADD COLUMN     "restOfWorldPrice" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "ExamResult" ADD COLUMN     "notPerformedReason" TEXT,
ADD COLUMN     "productId" INTEGER,
ADD COLUMN     "status" "ExamResultStatus" NOT NULL DEFAULT 'COMPLETED';

-- AlterTable
ALTER TABLE "InsuranceClaim" ADD COLUMN     "deductedAmount" DECIMAL(10,2),
ADD COLUMN     "deductionReason" TEXT;

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "foreignerRegion" "ForeignerRegion";

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "treatmentId" INTEGER;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "africaPrice" DECIMAL(10,2),
ADD COLUMN     "eastAfricaPrice" DECIMAL(10,2),
ADD COLUMN     "restOfWorldPrice" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "Refund" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "paymentId" INTEGER NOT NULL,
    "visitId" INTEGER NOT NULL,
    "examResultId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "approvalId" INTEGER,
    "patientRefundAmount" DECIMAL(10,2) NOT NULL,
    "insuranceAdjustmentAmount" DECIMAL(10,2) NOT NULL,
    "totalAdjustmentAmount" DECIMAL(10,2) NOT NULL,
    "reason" TEXT,
    "refundedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Refund_approvalId_key" ON "Refund"("approvalId");

-- CreateIndex
CREATE INDEX "Refund_clinicId_idx" ON "Refund"("clinicId");

-- CreateIndex
CREATE INDEX "Refund_paymentId_idx" ON "Refund"("paymentId");

-- CreateIndex
CREATE INDEX "Refund_visitId_idx" ON "Refund"("visitId");

-- CreateIndex
CREATE INDEX "Refund_examResultId_idx" ON "Refund"("examResultId");

-- CreateIndex
CREATE INDEX "Refund_productId_idx" ON "Refund"("productId");

-- CreateIndex
CREATE INDEX "Refund_refundedById_idx" ON "Refund"("refundedById");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_paymentId_examResultId_productId_key" ON "Refund"("paymentId", "examResultId", "productId");

-- CreateIndex
CREATE INDEX "ExamResult_productId_idx" ON "ExamResult"("productId");

-- CreateIndex
CREATE INDEX "ExamResult_status_idx" ON "ExamResult"("status");

-- CreateIndex
CREATE INDEX "Payment_treatmentId_idx" ON "Payment"("treatmentId");

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_treatmentId_fkey" FOREIGN KEY ("treatmentId") REFERENCES "Treatment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamResult" ADD CONSTRAINT "ExamResult_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_treatmentId_fkey" FOREIGN KEY ("treatmentId") REFERENCES "Treatment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_examResultId_fkey" FOREIGN KEY ("examResultId") REFERENCES "ExamResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_refundedById_fkey" FOREIGN KEY ("refundedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
