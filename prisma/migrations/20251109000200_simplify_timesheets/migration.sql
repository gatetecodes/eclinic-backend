-- Migration to simplify timesheets: convert shifts to daysOfWeek array, make dates required

-- Step 1: Add daysOfWeek column to StaffShift (as INTEGER array)
ALTER TABLE "public"."StaffShift" ADD COLUMN "daysOfWeek" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- Step 2: Migrate existing shift data to daysOfWeek array
-- Convert startDayOfWeek/endDayOfWeek to array of days
UPDATE "public"."StaffShift" ss
SET "daysOfWeek" = CASE
  -- If both startDayOfWeek and endDayOfWeek exist, create array spanning the range
  WHEN ss."startDayOfWeek" IS NOT NULL AND ss."endDayOfWeek" IS NOT NULL THEN
    CASE
      -- Same day: single element array
      WHEN ss."startDayOfWeek" = ss."endDayOfWeek" THEN ARRAY[ss."startDayOfWeek"]
      -- Cross-midnight: wrap around (e.g., Sat 22:00 to Sun 06:00)
      WHEN ss."startDayOfWeek" > ss."endDayOfWeek" THEN
        ARRAY(
          SELECT generate_series(ss."startDayOfWeek", 6)
          UNION ALL
          SELECT generate_series(0, ss."endDayOfWeek")
        )
      -- Normal range
      ELSE ARRAY(SELECT generate_series(ss."startDayOfWeek", ss."endDayOfWeek"))
    END
  -- If only dayOfMonth exists, convert to all days (since we can't map day-of-month to specific weekdays)
  -- This is a lossy conversion - we'll set to all weekdays as fallback
  WHEN ss."dayOfMonth" IS NOT NULL THEN ARRAY[0,1,2,3,4,5,6]
  -- Default: empty array (will need manual fix)
  ELSE ARRAY[]::INTEGER[]
END
WHERE ss."daysOfWeek" = ARRAY[]::INTEGER[];

-- Step 3: Set default startDate/endDate for existing timesheets that don't have them
-- For WEEK periodType: set to current week boundaries
-- For MONTH: set to current month boundaries
-- For CUSTOM: keep existing dates, or set to reasonable defaults
UPDATE "public"."StaffTimesheet" st
SET
  "startDate" = COALESCE(
    st."startDate",
    CASE st."periodType"
      WHEN 'WEEK' THEN date_trunc('week', CURRENT_DATE)
      WHEN 'MONTH' THEN date_trunc('month', CURRENT_DATE)
      ELSE CURRENT_DATE
    END
  ),
  "endDate" = COALESCE(
    st."endDate",
    CASE st."periodType"
      WHEN 'WEEK' THEN (date_trunc('week', CURRENT_DATE) + INTERVAL '6 days')::date + TIME '23:59:59'
      WHEN 'MONTH' THEN (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month - 1 day')::date + TIME '23:59:59'
      ELSE (CURRENT_DATE + INTERVAL '30 days')::date + TIME '23:59:59'
    END
  )
WHERE st."startDate" IS NULL OR st."endDate" IS NULL;

-- Step 4: Make startDate and endDate NOT NULL
ALTER TABLE "public"."StaffTimesheet"
  ALTER COLUMN "startDate" SET NOT NULL,
  ALTER COLUMN "endDate" SET NOT NULL;

-- Step 5: Drop old columns from StaffShift
ALTER TABLE "public"."StaffShift"
  DROP COLUMN "startDayOfWeek",
  DROP COLUMN "endDayOfWeek",
  DROP COLUMN "dayOfMonth";

-- Step 6: Update indexes (keep periodType index)
-- Drop existing indexes if they exist, then recreate them
DROP INDEX IF EXISTS "public"."StaffTimesheet_clinic_period_active_idx";
DROP INDEX IF EXISTS "public"."StaffTimesheet_user_active_date_idx";
CREATE INDEX "StaffTimesheet_user_active_date_idx" ON "public"."StaffTimesheet"("userId", "isActive", "startDate", "endDate");
CREATE INDEX "StaffTimesheet_clinic_period_active_idx" ON "public"."StaffTimesheet"("clinicId", "periodType", "isActive");

-- Step 7: Add constraint to ensure daysOfWeek is not empty
ALTER TABLE "public"."StaffShift"
  ADD CONSTRAINT "StaffShift_daysOfWeek_not_empty_chk"
  CHECK (array_length("daysOfWeek", 1) > 0);

-- Step 8: Add constraint to ensure endDate >= startDate
ALTER TABLE "public"."StaffTimesheet"
  ADD CONSTRAINT "StaffTimesheet_valid_date_range_chk"
  CHECK ("endDate" >= "startDate");
