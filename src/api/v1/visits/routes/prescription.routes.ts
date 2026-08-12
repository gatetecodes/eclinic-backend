import type { Hono } from "hono";
import type { AppEnv } from "../../../../middlewares/auth.middleware.ts";
import { requireQuota } from "../../../../middlewares/quota.middleware.ts";
import { validate } from "../../../../middlewares/validation.middleware.ts";
import { withAccess } from "../../../../middlewares/with-access.middleware.ts";
import {
  createPrescription,
  createSpectaclePrescription,
  updatePrescription,
  updateSpectaclePrescription,
} from "../controllers/prescription.controller.ts";
import {
  createPrescriptionSchema,
  createSpectaclePrescriptionSchema,
  getPrescriptionParamsSchema,
  updatePrescriptionSchema,
  updateSpectaclePrescriptionSchema,
} from "../visits.validation.ts";
import { createVisitRouteRegistrars } from "./register-route.ts";

export const registerPrescriptionVisitRoutes = (router: Hono<AppEnv>): void => {
  const { post, put } = createVisitRouteRegistrars(router);

  post(
    "/prescription",
    ...withAccess({ resource: "prescription", action: "create" }),
    validate(createPrescriptionSchema, "json"),
    createPrescription
  );
  put(
    "/prescription/:prescriptionId",
    validate(getPrescriptionParamsSchema, "param"),
    validate(updatePrescriptionSchema, "json"),
    ...withAccess({
      resource: "prescription",
      action: "update",
      feature: "printPrescription",
    }),
    requireQuota("printPrescription", 1, "soft"),
    updatePrescription
  );
  post(
    "/spectacle-prescription",
    validate(createSpectaclePrescriptionSchema, "json"),
    createSpectaclePrescription
  );
  put(
    "/spectacle-prescription/:prescriptionId",
    validate(getPrescriptionParamsSchema, "param"),
    validate(updateSpectaclePrescriptionSchema, "json"),
    updateSpectaclePrescription
  );
};
