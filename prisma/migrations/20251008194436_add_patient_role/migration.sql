-- AlterEnum
ALTER TYPE "public"."Role" ADD VALUE 'PATIENT';

-- CreateIndex
CREATE INDEX "Exam_clinicId_idx" ON "public"."Exam"("clinicId");

-- CreateIndex
CREATE INDEX "Exam_branchId_idx" ON "public"."Exam"("branchId");
