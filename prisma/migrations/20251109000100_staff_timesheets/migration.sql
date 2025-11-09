-- Create Enum
CREATE TYPE "public"."TimesheetPeriod" AS ENUM ('WEEK', 'MONTH', 'CUSTOM');

-- CreateTable StaffTimesheet
CREATE TABLE "public"."StaffTimesheet" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "periodType" "public"."TimesheetPeriod" NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StaffTimesheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable StaffShift
CREATE TABLE "public"."StaffShift" (
    "id" SERIAL NOT NULL,
    "timesheetId" INTEGER NOT NULL,
    "startDayOfWeek" INTEGER,
    "endDayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "branchId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StaffShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable StaffScheduleException
CREATE TABLE "public"."StaffScheduleException" (
    "id" SERIAL NOT NULL,
    "timesheetId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "isWorking" BOOLEAN NOT NULL DEFAULT false,
    "startTime" TEXT,
    "endTime" TEXT,
    "branchId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StaffScheduleException_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "StaffTimesheet_userId_idx" ON "public"."StaffTimesheet"("userId");
CREATE INDEX "StaffTimesheet_clinic_period_active_idx" ON "public"."StaffTimesheet"("clinicId", "periodType", "isActive");
CREATE INDEX "StaffTimesheet_user_active_date_idx" ON "public"."StaffTimesheet"("userId", "isActive", "startDate", "endDate");
CREATE INDEX "StaffShift_timesheetId_idx" ON "public"."StaffShift"("timesheetId");
CREATE INDEX "StaffShift_branchId_idx" ON "public"."StaffShift"("branchId");
CREATE UNIQUE INDEX "StaffScheduleException_timesheetId_date_key" ON "public"."StaffScheduleException"("timesheetId", "date");

-- Foreign Keys
ALTER TABLE "public"."StaffTimesheet"
ADD CONSTRAINT "StaffTimesheet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public"."StaffTimesheet"
ADD CONSTRAINT "StaffTimesheet_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public"."StaffShift"
ADD CONSTRAINT "StaffShift_timesheetId_fkey" FOREIGN KEY ("timesheetId") REFERENCES "public"."StaffTimesheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."StaffShift"
ADD CONSTRAINT "StaffShift_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "public"."Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "public"."StaffScheduleException"
ADD CONSTRAINT "StaffScheduleException_timesheetId_fkey" FOREIGN KEY ("timesheetId") REFERENCES "public"."StaffTimesheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data integrity constraints
ALTER TABLE "public"."StaffShift"
ADD CONSTRAINT "StaffShift_valid_pattern_chk"
CHECK (("dayOfMonth" IS NOT NULL) OR ("startDayOfWeek" IS NOT NULL AND "endDayOfWeek" IS NOT NULL));

ALTER TABLE "public"."StaffShift"
ADD CONSTRAINT "StaffShift_time_not_empty_chk"
CHECK (length("startTime") > 0 AND length("endTime") > 0);

ALTER TABLE "public"."StaffScheduleException"
ADD CONSTRAINT "StaffScheduleException_working_requires_times_chk"
CHECK (NOT "isWorking" OR ("startTime" IS NOT NULL AND "endTime" IS NOT NULL));

-- Backfill from DoctorAvailability to StaffTimesheet/StaffShift
-- One weekly timesheet per doctor with any availability rows.
INSERT INTO "public"."StaffTimesheet" ("userId", "clinicId", "periodType", "startDate", "endDate", "isActive", "createdAt", "updatedAt")
SELECT DISTINCT
  da."doctorId" AS "userId",
  u."clinicId" AS "clinicId",
  'WEEK'::"public"."TimesheetPeriod" AS "periodType",
  NULL::TIMESTAMP(3) AS "startDate",
  NULL::TIMESTAMP(3) AS "endDate",
  TRUE AS "isActive",
  NOW() AS "createdAt",
  NOW() AS "updatedAt"
FROM "public"."DoctorAvailability" da
JOIN "public"."User" u ON u.id = da."doctorId"
LEFT JOIN "public"."StaffTimesheet" st
  ON st."userId" = da."doctorId" AND st."periodType" = 'WEEK'::"public"."TimesheetPeriod"
WHERE u."clinicId" IS NOT NULL
  AND st."id" IS NULL;

-- Map each availability row to a StaffShift under the created timesheet
INSERT INTO "public"."StaffShift" ("timesheetId", "startDayOfWeek", "endDayOfWeek", "dayOfMonth", "startTime", "endTime", "branchId", "createdAt", "updatedAt")
SELECT
  st."id" AS "timesheetId",
  COALESCE(da."startDayOfWeek", da."dayOfWeek") AS "startDayOfWeek",
  COALESCE(da."endDayOfWeek", da."dayOfWeek")   AS "endDayOfWeek",
  NULL::INTEGER AS "dayOfMonth",
  da."startTime" AS "startTime",
  da."endTime" AS "endTime",
  NULL::INTEGER AS "branchId",
  NOW() AS "createdAt",
  NOW() AS "updatedAt"
FROM "public"."DoctorAvailability" da
JOIN "public"."StaffTimesheet" st ON st."userId" = da."doctorId" AND st."periodType" = 'WEEK'::"public"."TimesheetPeriod"
WHERE da."startTime" IS NOT NULL AND da."endTime" IS NOT NULL;
