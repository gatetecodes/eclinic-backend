-- DropForeignKey
ALTER TABLE "PharmacyIdempotencyRecord" DROP CONSTRAINT "PharmacyIdempotencyRecord_orderId_fkey";

-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN     "sku" TEXT;

-- AlterTable
ALTER TABLE "PharmacyPrescriptionItemMap" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "PharmacyIdempotencyRecord" ADD CONSTRAINT "PharmacyIdempotencyRecord_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PharmacyDispenseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "PharmacyIdempotencyRecord_clinicId_userId_key" RENAME TO "PharmacyIdempotencyRecord_clinicId_userId_key_key";
