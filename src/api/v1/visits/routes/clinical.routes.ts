import type { Hono } from "hono";
import type { AppEnv } from "../../../../middlewares/auth.middleware.ts";
import { validate } from "../../../../middlewares/validation.middleware.ts";
import { withAccess } from "../../../../middlewares/with-access.middleware.ts";
import {
  createConsultationNote,
  dischargeVisit,
  editChiefComplaint,
  editConsultationNote,
  finalizeVisit,
  getVisitBillingSummary,
  saveVisitDiagnoses,
  updateVisitStatus,
} from "../controllers/core.controller.ts";
import {
  addExams,
  addNurseTreatment,
  addTreatment,
  getVisitExam,
  markResultsReady,
  requestVisitExamEdit,
} from "../controllers/exams.controller.ts";
import {
  acceptHandoff,
  initiateHandoff,
  rejectHandoff,
  transferVisitToDoctor,
} from "../controllers/transfer.controller.ts";
import {
  addExamsSchema,
  addVisitNurseTreatmentBodySchema,
  addVisitTreatmentBodySchema,
  consultationNoteSchema,
  editChiefComplaintSchema,
  finalizeVisitSchema,
  getHandoffParamsSchema,
  getVisitParamsSchema,
  handoffSchema,
  rejectHandoffBodySchema,
  requestVisitExamEditBodySchema,
  transferVisitToDoctorSchema,
  updateVisitStatusSchema,
  visitDiagnosesSchema,
} from "../visits.validation.ts";
import { createVisitRouteRegistrars } from "./register-route.ts";

export const registerClinicalVisitRoutes = (router: Hono<AppEnv>): void => {
  const { get, post, put } = createVisitRouteRegistrars(router);

  post(
    "/:id/exams",
    validate(getVisitParamsSchema, "param"),
    validate(addExamsSchema, "json"),
    ...withAccess({ resource: "visits", action: "addExams" }),
    addExams
  );
  get("/:id/exam", validate(getVisitParamsSchema, "param"), getVisitExam);
  post(
    "/:id/results-ready",
    validate(getVisitParamsSchema, "param"),
    ...withAccess({ resource: "visits", action: "update" }),
    markResultsReady
  );
  post(
    "/:id/transfer",
    validate(getVisitParamsSchema, "param"),
    validate(transferVisitToDoctorSchema, "json"),
    transferVisitToDoctor
  );
  post(
    "/:id/exams/request-edit",
    validate(getVisitParamsSchema, "param"),
    validate(requestVisitExamEditBodySchema, "json"),
    ...withAccess({ resource: "visits", action: "update" }),
    requestVisitExamEdit
  );
  post(
    "/:id/consultation-note",
    validate(getVisitParamsSchema, "param"),
    validate(consultationNoteSchema, "json"),
    createConsultationNote
  );
  put(
    "/:id/consultation-note",
    validate(getVisitParamsSchema, "param"),
    validate(consultationNoteSchema, "json"),
    editConsultationNote
  );
  put(
    "/:id/diagnoses",
    validate(getVisitParamsSchema, "param"),
    validate(visitDiagnosesSchema, "json"),
    saveVisitDiagnoses
  );
  put(
    "/:id/chief-complaint",
    validate(getVisitParamsSchema, "param"),
    validate(editChiefComplaintSchema, "json"),
    editChiefComplaint
  );
  post(
    "/:id/finalize",
    validate(getVisitParamsSchema, "param"),
    validate(finalizeVisitSchema, "json"),
    finalizeVisit
  );
  post(
    "/:id/discharge",
    validate(getVisitParamsSchema, "param"),
    dischargeVisit
  );
  get(
    "/:id/billing-summary",
    validate(getVisitParamsSchema, "param"),
    getVisitBillingSummary
  );
  post(
    "/:id/treatment",
    validate(getVisitParamsSchema, "param"),
    validate(addVisitTreatmentBodySchema, "json"),
    addTreatment
  );
  post(
    "/:id/nurse-treatment",
    validate(getVisitParamsSchema, "param"),
    validate(addVisitNurseTreatmentBodySchema, "json"),
    addNurseTreatment
  );
  post("/handoff", validate(handoffSchema, "json"), initiateHandoff);
  post(
    "/handoff/:handoffId/accept",
    validate(getHandoffParamsSchema, "param"),
    acceptHandoff
  );
  post(
    "/handoff/:handoffId/reject",
    validate(getHandoffParamsSchema, "param"),
    validate(rejectHandoffBodySchema, "json"),
    rejectHandoff
  );
  put(
    "/:id/status",
    validate(getVisitParamsSchema, "param"),
    validate(updateVisitStatusSchema, "json"),
    updateVisitStatus
  );
};
