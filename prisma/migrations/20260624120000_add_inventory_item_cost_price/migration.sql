-- Add cost price to inventory items
ALTER TABLE "InventoryItem" ADD COLUMN "costPrice" DECIMAL(10,2);
