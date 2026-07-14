-- Add structured reference-range / critical-threshold config to ExamTest so
-- result flags (Normal/Low/High/Critical) can be derived automatically instead
-- of regex-parsing the free-text `normalRange` string.

-- CreateEnum
CREATE TYPE "ExamTestType" AS ENUM ('NUMERIC', 'QUALITATIVE');

-- AlterTable
ALTER TABLE "ExamTest"
  ADD COLUMN "specimen" TEXT,
  ADD COLUMN "testType" "ExamTestType" NOT NULL DEFAULT 'NUMERIC',
  ADD COLUMN "referenceLow" DECIMAL(12,4),
  ADD COLUMN "referenceHigh" DECIMAL(12,4),
  ADD COLUMN "criticalLow" DECIMAL(12,4),
  ADD COLUMN "criticalHigh" DECIMAL(12,4),
  ADD COLUMN "qualitativeExpected" TEXT;
