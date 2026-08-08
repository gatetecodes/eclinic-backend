ALTER TABLE "Patient"
ALTER COLUMN "dateOfBirth" TYPE DATE
USING (
  (
    "dateOfBirth" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Kigali'
  )::date
);
