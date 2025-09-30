/*
  Warnings:

  - A unique constraint covering the columns `[clinicId,featureKey]` on the table `EntitlementOverride` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "EntitlementOverride_clinicId_featureKey_key" ON "public"."EntitlementOverride"("clinicId", "featureKey");
