-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "QueueConfig" ADD COLUMN     "travelTimeBuffer" INTEGER NOT NULL DEFAULT 15;

-- AlterTable
ALTER TABLE "QueueEntry" ADD COLUMN     "isTravelAlertSent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "patientLat" DOUBLE PRECISION,
ADD COLUMN     "patientLng" DOUBLE PRECISION,
ADD COLUMN     "travelTimeEstimate" INTEGER;
