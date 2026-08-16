-- Per-capability HIE liveness.
-- A single lastHealthStatus scalar collapsed every probe into one value, so it
-- could not express "Client Registry down, SHR up" — leaving the reception
-- national-ID gate with nothing specific enough to key on. lastHealthStatus is
-- retained as the roll-up for the admin tile and the HEALTH_DEGRADED alert.

ALTER TABLE "HieTenantConfig" ADD COLUMN "capabilityHealth" JSONB;
