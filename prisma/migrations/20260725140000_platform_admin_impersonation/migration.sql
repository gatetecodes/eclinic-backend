-- Platform admin phase 3e: fields required by better-auth's admin() plugin.
--
-- Field names and types are dictated by the plugin's schema (see
-- node_modules/better-auth/dist/plugins/admin/index.d.ts) — they are not our
-- choice. Notably `impersonatedBy` is TEXT even though User.id is INTEGER,
-- because the plugin models all ids as strings.

-- AlterTable: marks a session as an operator acting as someone else. The value is
-- the impersonating (real) user's id, as text.
ALTER TABLE "session" ADD COLUMN "impersonatedBy" TEXT;

-- AlterTable: the plugin's ban mechanism. Used as the *enforcement* half of
-- suspending a user — better-auth refuses a banned user at session resolution,
-- which is a stronger guarantee than the app-level UserStatus check. UserStatus is
-- kept in sync for display and for existing queries.
ALTER TABLE "User" ADD COLUMN "banned" BOOLEAN DEFAULT false;
ALTER TABLE "User" ADD COLUMN "banReason" TEXT;
ALTER TABLE "User" ADD COLUMN "banExpires" TIMESTAMP(3);

-- Backfill: users already suspended/revoked through the app must also be banned at
-- the auth layer, otherwise registering the plugin would quietly re-admit them.
UPDATE "User"
SET "banned" = true,
    "banReason" = 'Backfilled from account status'
WHERE "status" IN ('BLOCKED', 'INACTIVE');
