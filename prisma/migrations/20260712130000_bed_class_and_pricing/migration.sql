-- Per-bed category & pricing: a ward mixes bed categories (standard/private/…)
-- at different daily rates, so pricing moves from Ward to Bed. Ward.dailyRate
-- stays as the default applied to newly-created beds.

CREATE TYPE "BedClass" AS ENUM ('STANDARD', 'SEMI_PRIVATE', 'PRIVATE', 'SUITE');

ALTER TABLE "Bed" ADD COLUMN "class" "BedClass" NOT NULL DEFAULT 'STANDARD';
ALTER TABLE "Bed" ADD COLUMN "dailyRate" DECIMAL(10,2);

-- Backfill existing beds from their ward's rate.
UPDATE "Bed" b SET "dailyRate" = w."dailyRate" FROM "Ward" w WHERE w."id" = b."wardId";

ALTER TABLE "Bed" ALTER COLUMN "dailyRate" SET NOT NULL;
