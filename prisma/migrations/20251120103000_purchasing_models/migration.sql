CREATE TABLE IF NOT EXISTS "Supplier" (
  "id" SERIAL PRIMARY KEY,
  "clinicId" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "contact" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "address" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
);

ALTER TABLE "Supplier"
  ADD CONSTRAINT "Supplier_clinicId_fkey"
  FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "PurchaseOrder" (
  "id" SERIAL PRIMARY KEY,
  "clinicId" INTEGER NOT NULL,
  "supplierId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "notes" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
);

ALTER TABLE "PurchaseOrder"
  ADD CONSTRAINT "PurchaseOrder_clinicId_fkey"
  FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrder"
  ADD CONSTRAINT "PurchaseOrder_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "PurchaseOrderLine" (
  "id" SERIAL PRIMARY KEY,
  "purchaseOrderId" INTEGER NOT NULL,
  "itemId" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unitPrice" DECIMAL(10,2),
  "notes" TEXT
);

ALTER TABLE "PurchaseOrderLine"
  ADD CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey"
  FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrderLine"
  ADD CONSTRAINT "PurchaseOrderLine_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "GoodsReceipt" (
  "id" SERIAL PRIMARY KEY,
  "clinicId" INTEGER NOT NULL,
  "supplierId" INTEGER NOT NULL,
  "purchaseOrderId" INTEGER,
  "notes" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
);

ALTER TABLE "GoodsReceipt"
  ADD CONSTRAINT "GoodsReceipt_clinicId_fkey"
  FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GoodsReceipt"
  ADD CONSTRAINT "GoodsReceipt_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GoodsReceipt"
  ADD CONSTRAINT "GoodsReceipt_purchaseOrderId_fkey"
  FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "GoodsReceiptLine" (
  "id" SERIAL PRIMARY KEY,
  "goodsReceiptId" INTEGER NOT NULL,
  "itemId" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unitPrice" DECIMAL(10,2),
  "batchNumber" TEXT,
  "expiryDate" TIMESTAMP,
  "notes" TEXT
);

ALTER TABLE "GoodsReceiptLine"
  ADD CONSTRAINT "GoodsReceiptLine_goodsReceiptId_fkey"
  FOREIGN KEY ("goodsReceiptId") REFERENCES "GoodsReceipt"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GoodsReceiptLine"
  ADD CONSTRAINT "GoodsReceiptLine_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
