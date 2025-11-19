-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "insuranceClaimId" INTEGER;

-- CreateIndex
CREATE INDEX "Payment_insuranceClaimId_idx" ON "Payment"("insuranceClaimId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_insuranceClaimId_fkey" FOREIGN KEY ("insuranceClaimId") REFERENCES "InsuranceClaim"("id") ON DELETE SET NULL ON UPDATE CASCADE;
