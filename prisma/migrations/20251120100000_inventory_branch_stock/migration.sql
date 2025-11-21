-- Add branchId to InventoryBatch and index
ALTER TABLE "InventoryBatch" ADD COLUMN IF NOT EXISTS "branchId" INTEGER;
CREATE INDEX IF NOT EXISTS "InventoryBatch_itemId_branchId_expiryDate_idx"
  ON "InventoryBatch"("itemId","branchId","expiryDate");
ALTER TABLE "InventoryBatch"
  ADD CONSTRAINT "InventoryBatch_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Add branchId to InventoryStock and composite unique
ALTER TABLE "InventoryStock" ADD COLUMN IF NOT EXISTS "branchId" INTEGER;
ALTER TABLE "InventoryStock"
  ADD CONSTRAINT "InventoryStock_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Replace unique constraint on itemId with composite (itemId, branchId)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'InventoryStock_itemId_key'
  ) THEN
    DROP INDEX "InventoryStock_itemId_key";
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "InventoryStock_itemId_branchId_key"
  ON "InventoryStock"("itemId","branchId");

-- Backfill branchId values from InventoryItem
UPDATE "InventoryBatch" b
SET "branchId" = i."branchId"
FROM "InventoryItem" i
WHERE b."itemId" = i."id" AND b."branchId" IS NULL;

UPDATE "InventoryStock" s
SET "branchId" = i."branchId"
FROM "InventoryItem" i
WHERE s."itemId" = i."id" AND s."branchId" IS NULL;
