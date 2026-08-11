import type { Hono } from "hono";
import type { AppEnv } from "../../../../middlewares/auth.middleware.ts";
import { validate } from "../../../../middlewares/validation.middleware.ts";
import { withAccess } from "../../../../middlewares/with-access.middleware.ts";
import {
  addPaymentMethod,
  addPreConsultation,
  createInitialCheckIn,
  editPreConsultation,
  getPatientVisits,
  getVisitById,
  listVisits,
  updateInitialCheckIn,
} from "../controllers/core.controller.ts";
import { getPatientsByPhone } from "../controllers/patient.controller.ts";
import {
  exportVisits,
  getTodaysVisits,
  getVisitsWithPrescriptions,
} from "../controllers/reports.controller.ts";
import {
  addPaymentMethodSchema,
  getPatientByPhoneSchema,
  getPatientVisitsParamsSchema,
  getVisitParamsSchema,
  initialCheckInSchema,
  preConsultationSchema,
  updatePreConsultationRequestSchema,
} from "../visits.validation.ts";
import { createVisitRouteRegistrars } from "./register-route.ts";

export const registerReceptionVisitRoutes = (router: Hono<AppEnv>): void => {
  const { get, post, put } = createVisitRouteRegistrars(router);

  get("/", listVisits);
  get("/today", getTodaysVisits);
  get("/todays", getTodaysVisits);
  post(
    "/patient-by-phone",
    validate(getPatientByPhoneSchema, "json"),
    getPatientsByPhone
  );
  get("/with-prescriptions", getVisitsWithPrescriptions);
  get("/export", exportVisits);
  get(
    "/patient/:patientId",
    validate(getPatientVisitsParamsSchema, "param"),
    getPatientVisits
  );
  get("/:id", validate(getVisitParamsSchema, "param"), getVisitById);

  post(
    "/check-in",
    validate(initialCheckInSchema, "json"),
    ...withAccess({ resource: "visits", action: "create" }),
    createInitialCheckIn
  );
  put(
    "/:id/initial-check-in",
    validate(getVisitParamsSchema, "param"),
    validate(initialCheckInSchema, "json"),
    ...withAccess({ resource: "visits", action: "updateInitialCheckin" }),
    updateInitialCheckIn
  );
  put(
    "/:id/pre-consultation",
    validate(getVisitParamsSchema, "param"),
    validate(updatePreConsultationRequestSchema, "json"),
    ...withAccess({ resource: "visits", action: "update" }),
    addPreConsultation
  );
  put(
    "/:id/pre-consultation/edit",
    validate(getVisitParamsSchema, "param"),
    validate(preConsultationSchema, "json"),
    ...withAccess({ resource: "visits", action: "update" }),
    editPreConsultation
  );
  post(
    "/:id/payment-mode",
    validate(getVisitParamsSchema, "param"),
    validate(addPaymentMethodSchema, "json"),
    ...withAccess({ resource: "visits", action: "addPaymentMethod" }),
    addPaymentMethod
  );
};
