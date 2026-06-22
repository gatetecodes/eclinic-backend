-- Align historical careStage values with the current runtime mapping for
-- PENDING_TESTS. Limit the correction to visits that predate the original
-- careStage backfill so explicitly advanced LAB visits created afterwards keep
-- their precise station.
UPDATE "Visit"
SET "careStage" = 'BILLING'::"CareStage"
WHERE "status" = 'PENDING_TESTS'
  AND "careStage" = 'LAB'::"CareStage"
  AND "createdAt" < TIMESTAMP '2026-06-20 12:00:00';
