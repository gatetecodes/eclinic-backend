-- CreateTable
CREATE TABLE "ClinicFlowConfig" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "branchId" INTEGER,
    "stage" "CareStage" NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicFlowConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClinicFlowConfig_clinicId_branchId_stage_key" ON "ClinicFlowConfig"("clinicId", "branchId", "stage");

-- CreateIndex
CREATE INDEX "ClinicFlowConfig_clinicId_branchId_idx" ON "ClinicFlowConfig"("clinicId", "branchId");

-- AddForeignKey
ALTER TABLE "ClinicFlowConfig" ADD CONSTRAINT "ClinicFlowConfig_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicFlowConfig" ADD CONSTRAINT "ClinicFlowConfig_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed a clinic-wide (branchId = NULL) default row for every existing clinic so
-- behaviour is unchanged on day one: every stage enabled, in the canonical
-- left-to-right pipeline order. Only the OPTIONAL stage (TRIAGE) is ever toggled
-- by admins; mandatory/conditional stages are kept here for completeness and a
-- consistent `position` baseline, but the engine never lets them be disabled.
INSERT INTO "ClinicFlowConfig" ("clinicId", "branchId", "stage", "position", "enabled", "updatedAt")
SELECT c."id", NULL, s."stage"::"CareStage", s."position", true, CURRENT_TIMESTAMP
FROM "Clinic" c
CROSS JOIN (
    VALUES
        ('RECEPTION', 0),
        ('TRIAGE', 1),
        ('DOCTOR', 2),
        ('LAB', 3),
        ('BILLING', 4),
        ('PHARMACY', 5),
        ('DONE', 6)
) AS s("stage", "position");
