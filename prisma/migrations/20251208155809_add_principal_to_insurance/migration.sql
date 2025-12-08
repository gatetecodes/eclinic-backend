-- CreateEnum
CREATE TYPE "InsuranceRelationshipType" AS ENUM ('PRINCIPAL', 'SPOUSE', 'CHILD', 'OTHER');

-- AlterTable
ALTER TABLE "PatientInsurance" ADD COLUMN     "principalName" TEXT,
ADD COLUMN     "principalPhoneNumber" TEXT,
ADD COLUMN     "relationshipType" "InsuranceRelationshipType" NOT NULL DEFAULT 'PRINCIPAL';
