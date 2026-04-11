-- DropForeignKey
ALTER TABLE "PharmacyIdempotencyRecord" DROP CONSTRAINT IF EXISTS "PharmacyIdempotencyRecord_orderId_fkey";

-- AlterTable (idempotent: sku may already exist from a prior migration name / partial apply)
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "sku" TEXT;

-- AlterTable
ALTER TABLE "PharmacyPrescriptionItemMap" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'PharmacyIdempotencyRecord_orderId_fkey'
    ) THEN
        ALTER TABLE "PharmacyIdempotencyRecord" ADD CONSTRAINT "PharmacyIdempotencyRecord_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PharmacyDispenseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

-- RenameIndex (skip if already renamed or old name missing)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'i'
          AND n.nspname = 'public'
          AND c.relname = 'PharmacyIdempotencyRecord_clinicId_userId_key'
    ) THEN
        ALTER INDEX "PharmacyIdempotencyRecord_clinicId_userId_key" RENAME TO "PharmacyIdempotencyRecord_clinicId_userId_key_key";
    END IF;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PharmacyDispenseLine_prescriptionItemId_key" ON "PharmacyDispenseLine"("prescriptionItemId");
