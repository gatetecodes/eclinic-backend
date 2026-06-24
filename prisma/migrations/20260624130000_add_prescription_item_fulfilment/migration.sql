-- Track where each prescribed medication is meant to be dispensed:
-- INTERNAL = clinic pharmacy inventory, EXTERNAL = outside pharmacy.
CREATE TYPE "PrescriptionItemFulfilment" AS ENUM ('INTERNAL', 'EXTERNAL');

ALTER TABLE "PrescriptionItem"
    ADD COLUMN "fulfilment" "PrescriptionItemFulfilment" NOT NULL DEFAULT 'INTERNAL';
