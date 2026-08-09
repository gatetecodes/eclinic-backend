-- Platform admin phase 3a, part 2 of 2: columns, backfills, indexes.
-- Depends on the enum values added in 20260725120000_platform_admin_phase3a_enums.

-- AlterTable: audit trail gains a taxonomy plus request provenance.
-- category/severity are added nullable, backfilled from the existing free-form
-- `action` strings, then made NOT NULL — adding them NOT NULL outright would fail
-- on any existing row, and adding a DEFAULT would drift from the Prisma schema.
ALTER TABLE "AdminAuditLog" ADD COLUMN "actorName" TEXT;
ALTER TABLE "AdminAuditLog" ADD COLUMN "ipAddress" TEXT;
ALTER TABLE "AdminAuditLog" ADD COLUMN "category" "AuditCategory";
ALTER TABLE "AdminAuditLog" ADD COLUMN "severity" "AuditSeverity";

-- Backfill existing rows to match the AUDIT_ACTIONS registry in
-- src/services/audit.service.ts. Anything unrecognised falls back to CONFIG/INFO.
UPDATE "AdminAuditLog" SET
  "category" = CASE
    WHEN "action" IN ('clinic.suspend', 'clinic.reactivate', 'clinic.subscriptionChanged') THEN 'BILLING'::"AuditCategory"
    ELSE 'CONFIG'::"AuditCategory"
  END,
  "severity" = CASE
    WHEN "action" IN ('clinic.suspend', 'clinic.archive') THEN 'WARNING'::"AuditSeverity"
    WHEN "action" IN ('clinic.reactivate', 'clinic.subscriptionChanged', 'entitlement.overridesUpdated') THEN 'NOTICE'::"AuditSeverity"
    ELSE 'INFO'::"AuditSeverity"
  END
WHERE "category" IS NULL OR "severity" IS NULL;

ALTER TABLE "AdminAuditLog" ALTER COLUMN "category" SET NOT NULL;
ALTER TABLE "AdminAuditLog" ALTER COLUMN "severity" SET NOT NULL;

-- CreateIndex: the console filters the audit log by category chip and badges
-- unreviewed CRITICAL events, both ordered by recency.
CREATE INDEX "AdminAuditLog_category_createdAt_idx" ON "AdminAuditLog"("category", "createdAt");
CREATE INDEX "AdminAuditLog_severity_createdAt_idx" ON "AdminAuditLog"("severity", "createdAt");

-- Backfill: suspend and archive both wrote INACTIVE before this migration, which
-- made them indistinguishable. archivedAt is the discriminator, so a non-archived
-- INACTIVE clinic was really a suspension.
UPDATE "Clinic"
SET "subscriptionStatus" = 'SUSPENDED'
WHERE "subscriptionStatus" = 'INACTIVE' AND "archivedAt" IS NULL;

-- Backfill: an ACTIVE account that never verified its email is an unaccepted
-- invitation, not an active user.
UPDATE "User"
SET "status" = 'INVITED'
WHERE "status" = 'ACTIVE' AND "emailVerified" IS NULL;
