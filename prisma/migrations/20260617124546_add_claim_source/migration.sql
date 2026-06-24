-- CreateEnum
CREATE TYPE "ClaimSource" AS ENUM ('DISCHARGE', 'CRON', 'MANUAL');

-- AlterTable
ALTER TABLE "InsuranceClaim" ADD COLUMN     "source" "ClaimSource" NOT NULL DEFAULT 'CRON';
