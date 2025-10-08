-- DropForeignKey
ALTER TABLE "public"."Exam" DROP CONSTRAINT "Exam_clinicId_fkey";

-- AlterTable
ALTER TABLE "public"."Exam" ALTER COLUMN "clinicId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "public"."Exam" ADD CONSTRAINT "Exam_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE SET NULL ON UPDATE CASCADE;
