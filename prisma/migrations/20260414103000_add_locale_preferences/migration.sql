ALTER TABLE "User"
ADD COLUMN "preferredLocale" TEXT;

ALTER TABLE "Clinic"
ADD COLUMN "defaultLocale" TEXT NOT NULL DEFAULT 'en';
