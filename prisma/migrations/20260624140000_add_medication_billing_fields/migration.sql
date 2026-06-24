-- Units to dispense/bill for an internal prescription line.
ALTER TABLE "PrescriptionItem" ADD COLUMN "quantity" INTEGER;

-- Whether insurance covers a medication; when false the patient pays in full.
ALTER TABLE "InventoryItem"
    ADD COLUMN "insuranceCovered" BOOLEAN NOT NULL DEFAULT true;
