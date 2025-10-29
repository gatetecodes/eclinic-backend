-- CreateTable
CREATE TABLE "public"."EntitlementOverride" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "featureKey" TEXT NOT NULL,
    "allowed" BOOLEAN,
    "limit" INTEGER,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntitlementOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EntitlementUsage" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "featureKey" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntitlementUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EntitlementOverride_clinicId_idx" ON "public"."EntitlementOverride"("clinicId");

-- CreateIndex
CREATE INDEX "EntitlementUsage_clinicId_featureKey_idx" ON "public"."EntitlementUsage"("clinicId", "featureKey");

-- CreateIndex
CREATE UNIQUE INDEX "EntitlementUsage_clinicId_featureKey_period_key" ON "public"."EntitlementUsage"("clinicId", "featureKey", "period");

-- AddForeignKey
ALTER TABLE "public"."EntitlementOverride" ADD CONSTRAINT "EntitlementOverride_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EntitlementUsage" ADD CONSTRAINT "EntitlementUsage_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
