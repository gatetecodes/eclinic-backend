-- DropForeignKey
ALTER TABLE "PharmacyIdempotencyRecord" DROP CONSTRAINT "PharmacyIdempotencyRecord_orderId_fkey";

-- AlterTable
ALTER TABLE "PharmacyIdempotencyRecord" ALTER COLUMN "orderId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "PharmacyIdempotencyRecord" ADD CONSTRAINT "PharmacyIdempotencyRecord_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PharmacyDispenseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
