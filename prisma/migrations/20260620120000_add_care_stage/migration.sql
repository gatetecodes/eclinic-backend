-- CreateEnum
CREATE TYPE "CareStage" AS ENUM ('RECEPTION', 'TRIAGE', 'DOCTOR', 'LAB', 'PHARMACY', 'BILLING', 'DONE');

-- AlterTable
ALTER TABLE "Visit" ADD COLUMN     "careStage" "CareStage" NOT NULL DEFAULT 'RECEPTION';

-- Backfill careStage from the existing VisitStatus so historical visits land on
-- the right pipeline station. Going forward this is kept in sync on every
-- status transition by the visit service layer.
UPDATE "Visit" SET "careStage" = CASE "status"
    WHEN 'CHECKED_IN'                   THEN 'RECEPTION'::"CareStage"
    WHEN 'IN_PRE_CONSULTATION'          THEN 'TRIAGE'::"CareStage"
    WHEN 'TRIAGE_COMPLETED'             THEN 'DOCTOR'::"CareStage"
    WHEN 'IN_CONSULTATION'              THEN 'DOCTOR'::"CareStage"
    WHEN 'PENDING_TESTS'                THEN 'LAB'::"CareStage"
    WHEN 'RESULTS_READY'                THEN 'DOCTOR'::"CareStage"
    WHEN 'FINALIZED'                    THEN 'BILLING'::"CareStage"
    WHEN 'DISCHARGED'                   THEN 'DONE'::"CareStage"
    WHEN 'DISCHARGED_WITH_PRESCRIPTION' THEN 'DONE'::"CareStage"
    WHEN 'ADMITTED'                     THEN 'DONE'::"CareStage"
    WHEN 'CANCELLED'                    THEN 'DONE'::"CareStage"
    ELSE 'RECEPTION'::"CareStage"
END;

-- CreateIndex
CREATE INDEX "Visit_careStage_idx" ON "Visit"("careStage");
