-- CreateTable
CREATE TABLE "Triage" (
    "id" SERIAL NOT NULL,
    "visitId" INTEGER NOT NULL,
    "height" TEXT,
    "weight" TEXT,
    "temperature" TEXT,
    "bloodType" TEXT,
    "heartRate" TEXT,
    "bloodPressure" TEXT,
    "bloodSugar" TEXT,
    "respiratory" TEXT,
    "hemoglobin" TEXT,
    "spo2" TEXT,
    "bmi" TEXT,
    "chiefComplaint" TEXT,
    "acuity" "Priority",
    "notes" TEXT,
    "recordedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Triage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Triage_visitId_key" ON "Triage"("visitId");

-- CreateIndex
CREATE INDEX "Triage_visitId_idx" ON "Triage"("visitId");

-- CreateIndex
CREATE INDEX "Triage_recordedById_idx" ON "Triage"("recordedById");

-- AddForeignKey
ALTER TABLE "Triage" ADD CONSTRAINT "Triage_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Triage" ADD CONSTRAINT "Triage_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill per-visit triage from the legacy Visit.basicTriage JSON where it was
-- captured, plus the visit's own chiefComplaint/priority. Visits without
-- basicTriage are left untouched (no reliable per-visit vitals source).
INSERT INTO "Triage" (
    "visitId", "height", "weight", "temperature", "bloodType", "heartRate",
    "bloodPressure", "bloodSugar", "respiratory", "hemoglobin", "spo2", "bmi",
    "chiefComplaint", "acuity", "updatedAt"
)
SELECT
    v."id",
    v."basicTriage"->>'height',
    v."basicTriage"->>'weight',
    v."basicTriage"->>'temperature',
    v."basicTriage"->>'bloodType',
    v."basicTriage"->>'heartRate',
    v."basicTriage"->>'bloodPressure',
    v."basicTriage"->>'bloodSugar',
    v."basicTriage"->>'respiratory',
    v."basicTriage"->>'hemoglobin',
    v."basicTriage"->>'spo2',
    v."basicTriage"->>'bmi',
    v."chiefComplaint",
    v."priority",
    CURRENT_TIMESTAMP
FROM "Visit" v
WHERE v."basicTriage" IS NOT NULL
  AND jsonb_typeof(v."basicTriage") = 'object';
