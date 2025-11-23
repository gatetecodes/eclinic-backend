/*
  Warnings:

  - The `status` column on the `PurchaseOrder` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[itemId]` on the table `InventoryStock` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "POStatus" AS ENUM ('DRAFT', 'APPROVED', 'RECEIVED', 'CANCELLED');

-- DropForeignKey
ALTER TABLE "public"."GoodsReceiptLine" DROP CONSTRAINT "GoodsReceiptLine_goodsReceiptId_fkey";

-- DropForeignKey
ALTER TABLE "public"."PurchaseOrderLine" DROP CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey";

-- AlterTable
ALTER TABLE "GoodsReceipt" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "GoodsReceiptLine" ALTER COLUMN "expiryDate" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PurchaseOrder" DROP COLUMN "status",
ADD COLUMN     "status" "POStatus" NOT NULL DEFAULT 'DRAFT',
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Supplier" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_goodsReceiptId_fkey" FOREIGN KEY ("goodsReceiptId") REFERENCES "GoodsReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
