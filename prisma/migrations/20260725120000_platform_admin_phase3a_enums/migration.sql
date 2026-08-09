-- Platform admin phase 3a, part 1 of 2: type additions only.
--
-- PostgreSQL refuses to let a newly added enum value be used by DML in the same
-- transaction that added it ("unsafe use of new value of enum type"). Prisma runs
-- each migration file in one transaction, so the ALTER TYPE ... ADD VALUE
-- statements must land in their own migration, separate from the backfills that
-- reference them (see 20260725120100_platform_admin_phase3a).

-- CreateEnum
CREATE TYPE "AuditCategory" AS ENUM ('SECURITY', 'MEMBERSHIP', 'BILLING', 'ACCESS', 'CONFIG');

-- CreateEnum
CREATE TYPE "AuditSeverity" AS ENUM ('CRITICAL', 'WARNING', 'NOTICE', 'INFO');

-- AlterEnum: distinguish an operator-suspended clinic from an archived one, and
-- mark clinics that are provisioned but not yet set up.
ALTER TYPE "SubscriptionStatus" ADD VALUE 'SUSPENDED';
ALTER TYPE "SubscriptionStatus" ADD VALUE 'ONBOARDING';

-- AlterEnum: invited-but-not-yet-accepted staff accounts.
ALTER TYPE "UserStatus" ADD VALUE 'INVITED';
