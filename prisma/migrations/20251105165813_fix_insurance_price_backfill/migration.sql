-- Fix InsurancePrice backfill: Create clinic-specific insurance prices for all clinics that have each product
-- This ensures existing insurance prices are available to all clinics that use the product
-- Only processes records that don't already have a clinicId (the newly added column will be NULL for existing records)

INSERT INTO "public"."InsurancePrice" ("productId", "price", "priceWithCo", "insuranceCompanyId", "priceType", "clinicId")
SELECT DISTINCT
    ip."productId",
    ip."price",
    ip."priceWithCo",
    ip."insuranceCompanyId",
    ip."priceType",
    cp."A" as "clinicId"
FROM "InsurancePrice" ip
INNER JOIN "_ClinicToProduct" cp ON cp."B" = ip."productId"
WHERE ip."clinicId" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "InsurancePrice" existing
    WHERE existing."productId" = ip."productId"
      AND existing."insuranceCompanyId" = ip."insuranceCompanyId"
      AND existing."clinicId" = cp."A"
  )
ON CONFLICT ("productId", "insuranceCompanyId", "clinicId") DO NOTHING;
