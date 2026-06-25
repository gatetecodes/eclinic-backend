-- Allow ClinicFlowConfig.branch to reference Branch within the same clinic only.
CREATE UNIQUE INDEX "Branch_id_clinicId_key" ON "Branch"("id", "clinicId");

ALTER TABLE "ClinicFlowConfig"
DROP CONSTRAINT "ClinicFlowConfig_branchId_fkey";

ALTER TABLE "ClinicFlowConfig"
ADD CONSTRAINT "ClinicFlowConfig_branchId_clinicId_fkey"
FOREIGN KEY ("branchId", "clinicId")
REFERENCES "Branch"("id", "clinicId")
ON DELETE CASCADE
ON UPDATE CASCADE;
