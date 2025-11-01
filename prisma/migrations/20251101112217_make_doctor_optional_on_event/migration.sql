-- DropForeignKey
ALTER TABLE "public"."Event" DROP CONSTRAINT "Event_doctorId_fkey";

-- AlterTable
ALTER TABLE "Event" ALTER COLUMN "doctorId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
