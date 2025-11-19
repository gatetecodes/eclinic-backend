-- AlterEnum
ALTER TYPE "ClaimStatus" ADD VALUE 'PAID';

-- DropForeignKey
ALTER TABLE "public"."ClinicProductPrice" DROP CONSTRAINT "ClinicProductPrice_clinicId_fkey";

-- DropForeignKey
ALTER TABLE "public"."ClinicProductPrice" DROP CONSTRAINT "ClinicProductPrice_productId_fkey";

-- DropForeignKey
ALTER TABLE "public"."InsurancePrice" DROP CONSTRAINT "InsurancePrice_clinicId_fkey";

-- DropForeignKey
ALTER TABLE "public"."StaffScheduleException" DROP CONSTRAINT "StaffScheduleException_timesheetId_fkey";

-- DropForeignKey
ALTER TABLE "public"."StaffShift" DROP CONSTRAINT "StaffShift_timesheetId_fkey";

-- AlterTable
ALTER TABLE "StaffShift" ALTER COLUMN "daysOfWeek" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "InsurancePrice" ADD CONSTRAINT "InsurancePrice_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicProductPrice" ADD CONSTRAINT "ClinicProductPrice_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicProductPrice" ADD CONSTRAINT "ClinicProductPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffShift" ADD CONSTRAINT "StaffShift_timesheetId_fkey" FOREIGN KEY ("timesheetId") REFERENCES "StaffTimesheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffScheduleException" ADD CONSTRAINT "StaffScheduleException_timesheetId_fkey" FOREIGN KEY ("timesheetId") REFERENCES "StaffTimesheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "StaffTimesheet_clinic_period_active_idx" RENAME TO "StaffTimesheet_clinicId_periodType_isActive_idx";

-- RenameIndex
ALTER INDEX "StaffTimesheet_user_active_date_idx" RENAME TO "StaffTimesheet_userId_isActive_startDate_endDate_idx";
