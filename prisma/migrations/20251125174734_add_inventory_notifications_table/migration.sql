-- CreateTable
CREATE TABLE "InventoryExpiryNotification" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "batchId" INTEGER NOT NULL,
    "firstNotificationAt" TIMESTAMP(3),
    "lastNotificationAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryExpiryNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InventoryExpiryNotification_batchId_key" ON "InventoryExpiryNotification"("batchId");

-- CreateIndex
CREATE INDEX "InventoryExpiryNotification_clinicId_idx" ON "InventoryExpiryNotification"("clinicId");

-- CreateIndex
CREATE INDEX "InventoryExpiryNotification_itemId_idx" ON "InventoryExpiryNotification"("itemId");

-- AddForeignKey
ALTER TABLE "InventoryExpiryNotification" ADD CONSTRAINT "InventoryExpiryNotification_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryExpiryNotification" ADD CONSTRAINT "InventoryExpiryNotification_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryExpiryNotification" ADD CONSTRAINT "InventoryExpiryNotification_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "InventoryBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
