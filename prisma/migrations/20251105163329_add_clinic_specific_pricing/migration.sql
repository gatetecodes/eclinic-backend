-- CreateTable
CREATE TABLE "public"."ClinicProductPrice" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "basePrice" DECIMAL(10,2),
    "foreignersPrice" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicProductPrice_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "public"."InsurancePrice" ADD COLUMN "clinicId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "ClinicProductPrice_clinicId_productId_key" ON "public"."ClinicProductPrice"("clinicId", "productId");

-- CreateIndex
CREATE INDEX "ClinicProductPrice_clinicId_idx" ON "public"."ClinicProductPrice"("clinicId");

-- CreateIndex
CREATE INDEX "ClinicProductPrice_productId_idx" ON "public"."ClinicProductPrice"("productId");

-- CreateIndex
CREATE INDEX "InsurancePrice_clinicId_idx" ON "public"."InsurancePrice"("clinicId");

-- CreateIndex
CREATE INDEX "InsurancePrice_productId_clinicId_idx" ON "public"."InsurancePrice"("productId", "clinicId");

-- DropIndex
DROP INDEX IF EXISTS "public"."InsurancePrice_productId_insuranceCompanyId_key";

-- CreateIndex
CREATE UNIQUE INDEX "InsurancePrice_productId_insuranceCompanyId_clinicId_key" ON "public"."InsurancePrice"("productId", "insuranceCompanyId", "clinicId");

-- AddForeignKey
ALTER TABLE "public"."ClinicProductPrice" ADD CONSTRAINT "ClinicProductPrice_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ClinicProductPrice" ADD CONSTRAINT "ClinicProductPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InsurancePrice" ADD CONSTRAINT "InsurancePrice_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill ClinicProductPrice: Migrate existing Product basePrice/foreignersPrice to ClinicProductPrice
-- for all clinic-product relationships where prices exist
INSERT INTO "public"."ClinicProductPrice" ("clinicId", "productId", "basePrice", "foreignersPrice", "createdAt", "updatedAt")
SELECT
    cp."A" as "clinicId",
    cp."B" as "productId",
    p."basePrice",
    p."foreignersPrice",
    NOW() as "createdAt",
    NOW() as "updatedAt"
FROM "_ClinicToProduct" cp
INNER JOIN "Product" p ON p.id = cp."B"
WHERE (p."basePrice" IS NOT NULL OR p."foreignersPrice" IS NOT NULL)
ON CONFLICT ("clinicId", "productId") DO NOTHING;

-- Backfill InsurancePrice: Create clinic-specific insurance prices for all clinics that have each product
-- This ensures existing insurance prices are available to all clinics that use the product
CREATE TEMP TABLE temp_clinic_insurance_prices AS
SELECT
    ip."productId",
    ip."price",
    ip."priceWithCo",
    ip."insuranceCompanyId",
    ip."priceType",
    cp."A" as "clinicId"
FROM "InsurancePrice" ip
INNER JOIN "_ClinicToProduct" cp ON cp."B" = ip."productId"
WHERE ip."clinicId" IS NULL;

INSERT INTO "public"."InsurancePrice" ("productId", "price", "priceWithCo", "insuranceCompanyId", "priceType", "clinicId")
SELECT
    "productId",
    "price",
    "priceWithCo",
    "insuranceCompanyId",
    "priceType",
    "clinicId"
FROM temp_clinic_insurance_prices
ON CONFLICT ("productId", "insuranceCompanyId", "clinicId") DO NOTHING;
DROP TABLE IF EXISTS temp_clinic_insurance_prices;
