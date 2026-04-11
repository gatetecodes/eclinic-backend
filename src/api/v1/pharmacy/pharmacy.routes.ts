import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";
import { withAccess } from "../../../middlewares/with-access.middleware.ts";
import {
  deletePrescriptionItemMapping,
  getPharmacyDispenseOrders,
  getPharmacyPrescriptionDetail,
  getPharmacyQueue,
  mapPrescriptionItemToInventory,
  postPharmacyDispense,
} from "./pharmacy.controller.ts";
import {
  mapPrescriptionItemSchema,
  pharmacyDispenseSchema,
} from "./pharmacy.validation.ts";

const router = new Hono<AppEnv>();

router.get(
  "/queue",
  ...withAccess({ resource: "pharmacy", action: "read", feature: "pharmacy" }),
  getPharmacyQueue
);

router.get(
  "/dispense-orders",
  ...withAccess({ resource: "pharmacy", action: "read", feature: "pharmacy" }),
  getPharmacyDispenseOrders
);

router.get(
  "/prescriptions/:prescriptionId",
  ...withAccess({ resource: "pharmacy", action: "read", feature: "pharmacy" }),
  getPharmacyPrescriptionDetail
);

router.post(
  "/dispense",
  ...withAccess({
    resource: "pharmacy",
    action: "dispense",
    feature: "pharmacy",
  }),
  validate(pharmacyDispenseSchema, "json"),
  postPharmacyDispense
);

router.post(
  "/prescription-items/:prescriptionItemId/map",
  ...withAccess({
    resource: "pharmacy",
    action: "update",
    feature: "pharmacy",
  }),
  validate(mapPrescriptionItemSchema, "json"),
  mapPrescriptionItemToInventory
);

router.delete(
  "/prescription-items/:prescriptionItemId/map",
  ...withAccess({
    resource: "pharmacy",
    action: "update",
    feature: "pharmacy",
  }),
  deletePrescriptionItemMapping
);

export default router;
