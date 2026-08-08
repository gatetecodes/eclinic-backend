-- Platform-admin console, Phase 2.
-- Adds the operator audit trail, clinic soft-delete (archive lifecycle), and a
-- link from an approved demo request to the clinic it provisioned.

-- Operator action trail (cross-tenant; distinct from clinical ActivityLog).
CREATE TABLE "AdminAuditLog" (
    "id" SERIAL NOT NULL,
    "actorId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminAuditLog_actorId_idx" ON "AdminAuditLog"("actorId");
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");
CREATE INDEX "AdminAuditLog_targetType_targetId_idx" ON "AdminAuditLog"("targetType", "targetId");

ALTER TABLE "AdminAuditLog"
    ADD CONSTRAINT "AdminAuditLog_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Clinic soft-delete for the archive lifecycle.
ALTER TABLE "Clinic" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- Link an approved demo request to the clinic it provisioned.
ALTER TABLE "DemoRequest" ADD COLUMN "clinicId" INTEGER;

CREATE INDEX "DemoRequest_clinicId_idx" ON "DemoRequest"("clinicId");

ALTER TABLE "DemoRequest"
    ADD CONSTRAINT "DemoRequest_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
