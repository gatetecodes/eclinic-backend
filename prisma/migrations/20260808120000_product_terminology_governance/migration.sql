CREATE TYPE "ProductTerminologyStatus" AS ENUM ('DRAFT', 'VERIFIED');

ALTER TABLE "Product"
ADD COLUMN "terminologyStatus" "ProductTerminologyStatus" NOT NULL DEFAULT 'DRAFT',
ADD COLUMN "terminologyVerifiedAt" TIMESTAMP(3),
ADD COLUMN "terminologyVerifiedById" INTEGER;

ALTER TABLE "Product"
ADD CONSTRAINT "Product_terminologyVerifiedById_fkey"
FOREIGN KEY ("terminologyVerifiedById") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Product_terminologyStatus_idx" ON "Product"("terminologyStatus");
CREATE INDEX "Product_terminologyVerifiedById_idx" ON "Product"("terminologyVerifiedById");
