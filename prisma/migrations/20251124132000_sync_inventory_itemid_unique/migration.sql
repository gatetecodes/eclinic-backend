-- Record unique constraint on InventoryStock(itemId) to match Prisma schema
-- Safe on existing DBs (no-op if the constraint already exists), applies cleanly on fresh DBs.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        WHERE c.conrelid = 'public."InventoryStock"'::regclass
          AND c.contype = 'u'
          AND c.conkey = ARRAY[
              (SELECT attnum
               FROM pg_attribute
               WHERE attrelid = 'public."InventoryStock"'::regclass
                 AND attname = 'itemId')
          ]
    ) THEN
        ALTER TABLE "public"."InventoryStock"
        ADD CONSTRAINT "InventoryStock_itemId_key" UNIQUE ("itemId");
    END IF;
END
$$;
