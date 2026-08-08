-- Platform admin phase 3d: plan price catalogue + global platform settings.
--
-- No new enum values here, so this can safely run in a single transaction
-- (unlike the phase-3a pair).

-- CreateTable: commercial facts per subscription tier. Keyed to the existing
-- SubscriptionPlan enum, which remains the basis of every entitlement check.
CREATE TABLE "Plan" (
    "id" SERIAL NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "monthlyPrice" DECIMAL(12,2) NOT NULL,
    "currency" "CurrencyCode" NOT NULL DEFAULT 'RWF',
    "seatCap" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_plan_key" ON "Plan"("plan");

-- CreateTable: single-row global configuration (id pinned to 1 by the app).
CREATE TABLE "PlatformSetting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "requireTwoFactor" BOOLEAN NOT NULL DEFAULT false,
    "restrictAdminIps" BOOLEAN NOT NULL DEFAULT false,
    "impersonationIdleTimeoutMinutes" INTEGER NOT NULL DEFAULT 15,
    "requireExportReason" BOOLEAN NOT NULL DEFAULT true,
    "auditRetentionDays" INTEGER NOT NULL DEFAULT 90,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("id")
);

-- Seed the three tiers so the Subscriptions screen and MRR are populated on first
-- boot rather than showing an empty catalogue. Prices are placeholders the
-- operator is expected to edit; ON CONFLICT keeps a re-run from overwriting
-- whatever they set.
INSERT INTO "Plan" ("plan", "label", "description", "monthlyPrice", "currency", "seatCap", "updatedAt")
VALUES
  ('CLINIC_STARTER', 'Starter',    'Single site · core clinic flow',                      180000, 'RWF', 15,   CURRENT_TIMESTAMP),
  ('MEDICAL_PLUS',   'Growth',     'Multi-department · labs, pharmacy, billing',          450000, 'RWF', 60,   CURRENT_TIMESTAMP),
  ('HOSPITAL_SUITE', 'Enterprise', 'Full suite · inpatient, multi-site, priority support', 1200000, 'RWF', NULL, CURRENT_TIMESTAMP)
ON CONFLICT ("plan") DO NOTHING;

-- Seed the settings row with schema defaults.
INSERT INTO "PlatformSetting" ("id", "updatedAt")
VALUES (1, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
