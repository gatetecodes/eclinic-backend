-- AlterTable
ALTER TABLE "InsurancePrice" ADD COLUMN     "insurerItemCode" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "icd11Code" TEXT,
ADD COLUMN     "loincCode" TEXT,
ADD COLUMN     "nationalTariffCode" TEXT;

-- CreateTable
CREATE TABLE "VisitDiagnosis" (
    "id" SERIAL NOT NULL,
    "visitId" INTEGER NOT NULL,
    "icd11Code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisitDiagnosis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VisitDiagnosis_visitId_idx" ON "VisitDiagnosis"("visitId");

-- CreateIndex
CREATE INDEX "VisitDiagnosis_icd11Code_idx" ON "VisitDiagnosis"("icd11Code");

-- CreateIndex
CREATE INDEX "Product_nationalTariffCode_idx" ON "Product"("nationalTariffCode");

-- AddForeignKey
ALTER TABLE "VisitDiagnosis" ADD CONSTRAINT "VisitDiagnosis_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
