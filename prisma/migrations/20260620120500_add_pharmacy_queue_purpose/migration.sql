-- AlterEnum
-- Adds a PHARMACY station to the queue model so the Pharmacy pipeline stage has
-- a queue to align to (parity with the patient-flow design). Appended at the
-- end of the enum; existing values are unchanged.
ALTER TYPE "QueuePurpose" ADD VALUE 'PHARMACY';
