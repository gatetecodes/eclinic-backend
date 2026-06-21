import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { requireQuota } from "../../../middlewares/quota.middleware.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";
import { withAccess } from "../../../middlewares/with-access.middleware.ts";
// core controllers
// core controllers
import {
  addPaymentMethod,
  addPreConsultation,
  createConsultationNote,
  createInitialCheckIn,
  dischargeVisit,
  editChiefComplaint,
  editConsultationNote,
  editPreConsultation,
  finalizeVisit,
  getPatientVisits,
  getVisitBillingSummary,
  getVisitById,
  listVisits,
  updateInitialCheckIn,
  updateVisitStatus,
} from "./controllers/core.controller.ts";
// exams controllers (migrated out for maintainability)
import {
  addExams,
  addNurseTreatment,
  addTreatment,
  getVisitExam,
  markResultsReady,
  requestVisitExamEdit,
} from "./controllers/exams.controller.ts";
// flow controllers (visual patient-flow pipeline)
// flow controllers (visual patient-flow pipeline)
import {
  advanceVisitStage,
  createFlowCheckIn,
  getPipeline,
  getStageSummary,
} from "./controllers/flow.controller.ts";
//Patient controllers
import { getPatientsByPhone } from "./controllers/patient.controller.ts";
// prescription controllers
import {
  createPrescription,
  createSpectaclePrescription,
  updatePrescription,
  updateSpectaclePrescription,
} from "./controllers/prescription.controller.ts";
// reports controllers
import {
  exportVisits,
  getTodaysVisits,
  getVisitsWithPrescriptions,
} from "./controllers/reports.controller.ts";
// transfer controllers
import {
  acceptHandoff,
  initiateHandoff,
  rejectHandoff,
  transferVisitToDoctor,
} from "./controllers/transfer.controller.ts";

import {
  addExamsSchema,
  addPaymentMethodSchema,
  addVisitNurseTreatmentBodySchema,
  addVisitTreatmentBodySchema,
  advanceVisitSchema,
  consultationNoteSchema,
  createPrescriptionSchema,
  createSpectaclePrescriptionSchema,
  editChiefComplaintSchema,
  finalizeVisitSchema,
  flowCheckInSchema,
  getHandoffParamsSchema,
  getPatientByPhoneSchema,
  getPatientVisitsParamsSchema,
  getPrescriptionParamsSchema,
  getVisitParamsSchema,
  handoffSchema,
  initialCheckInSchema,
  preConsultationSchema,
  rejectHandoffBodySchema,
  requestVisitExamEditBodySchema,
  transferVisitToDoctorSchema,
  updatePreConsultationRequestSchema,
  updatePrescriptionSchema,
  updateSpectaclePrescriptionSchema,
  updateVisitStatusSchema,
} from "./visits.validation.ts";

const router = new Hono<AppEnv>();

router.get("/", listVisits);
// Patient-flow pipeline (live snapshot grouped by stage)
router.get("/pipeline", getPipeline);
// Slim reception check-in (new flow): patient + payment mode only
router.post(
  "/flow/check-in",
  validate(flowCheckInSchema, "json"),
  ...withAccess({ resource: "visits", action: "create" }),
  createFlowCheckIn
);
router.get("/today", getTodaysVisits);
router.get("/todays", getTodaysVisits);
router.post(
  "/patient-by-phone",
  validate(getPatientByPhoneSchema, "json"),
  getPatientsByPhone
);
router.get("/:id", validate(getVisitParamsSchema, "param"), getVisitById);

// New parity endpoints
router.post(
  "/check-in",
  validate(initialCheckInSchema, "json"),
  ...withAccess({ resource: "visits", action: "create" }),
  createInitialCheckIn
);
router.put(
  "/:id/initial-check-in",
  validate(getVisitParamsSchema, "param"),
  validate(initialCheckInSchema, "json"),
  ...withAccess({ resource: "visits", action: "updateInitialCheckin" }),
  updateInitialCheckIn
);
router.put(
  "/:id/pre-consultation",
  validate(getVisitParamsSchema, "param"),
  validate(updatePreConsultationRequestSchema, "json"),
  ...withAccess({ resource: "visits", action: "update" }),
  addPreConsultation
);

router.put(
  "/:id/pre-consultation/edit",
  validate(getVisitParamsSchema, "param"),
  validate(preConsultationSchema, "json"),
  ...withAccess({ resource: "visits", action: "update" }),
  editPreConsultation
);

// Payment mode
router.post(
  "/:id/payment-mode",
  validate(getVisitParamsSchema, "param"),
  validate(addPaymentMethodSchema, "json"),
  ...withAccess({ resource: "visits", action: "addPaymentMethod" }),
  addPaymentMethod
);

// Exams
router.post(
  "/:id/exams",
  validate(getVisitParamsSchema, "param"),
  validate(addExamsSchema, "json"),
  ...withAccess({ resource: "visits", action: "addExams" }),
  addExams
);
router.get("/:id/exam", validate(getVisitParamsSchema, "param"), getVisitExam);

// Results ready
router.post(
  "/:id/results-ready",
  validate(getVisitParamsSchema, "param"),
  ...withAccess({ resource: "visits", action: "update" }),
  markResultsReady
);

// Transfer to doctor
router.post(
  "/:id/transfer",
  validate(getVisitParamsSchema, "param"),
  validate(transferVisitToDoctorSchema, "json"),
  transferVisitToDoctor
);
// Request exam edit (creates approval, preferred)
router.post(
  "/:id/exams/request-edit",
  validate(getVisitParamsSchema, "param"),
  validate(requestVisitExamEditBodySchema, "json"),
  ...withAccess({ resource: "visits", action: "update" }),
  requestVisitExamEdit
);

// Visits with prescriptions
router.get("/with-prescriptions", getVisitsWithPrescriptions);

// Export visits
router.get("/export", exportVisits);

// Consultation notes
router.post(
  "/:id/consultation-note",
  validate(getVisitParamsSchema, "param"),
  validate(consultationNoteSchema, "json"),
  createConsultationNote
);
router.put(
  "/:id/consultation-note",
  validate(getVisitParamsSchema, "param"),
  validate(consultationNoteSchema, "json"),
  editConsultationNote
);

// Chief complaint
router.put(
  "/:id/chief-complaint",
  validate(getVisitParamsSchema, "param"),
  validate(editChiefComplaintSchema, "json"),
  editChiefComplaint
);

// Finalize visit
router.post(
  "/:id/finalize",
  validate(getVisitParamsSchema, "param"),
  validate(finalizeVisitSchema, "json"),
  finalizeVisit
);

// Discharge visit
router.post(
  "/:id/discharge",
  validate(getVisitParamsSchema, "param"),
  dischargeVisit
);

// Billing summary (patient vs insurance responsibility) — drives discharge UI
router.get(
  "/:id/billing-summary",
  validate(getVisitParamsSchema, "param"),
  getVisitBillingSummary
);

// Treatments
router.post(
  "/:id/treatment",
  validate(getVisitParamsSchema, "param"),
  validate(addVisitTreatmentBodySchema, "json"),
  addTreatment
);
router.post(
  "/:id/nurse-treatment",
  validate(getVisitParamsSchema, "param"),
  validate(addVisitNurseTreatmentBodySchema, "json"),
  addNurseTreatment
);

// Patient visits
router.get(
  "/patient/:patientId",
  validate(getPatientVisitsParamsSchema, "param"),
  getPatientVisits
);

// Handoffs
router.post("/handoff", validate(handoffSchema, "json"), initiateHandoff);
router.post(
  "/handoff/:handoffId/accept",
  validate(getHandoffParamsSchema, "param"),
  acceptHandoff
);
router.post(
  "/handoff/:handoffId/reject",
  validate(getHandoffParamsSchema, "param"),
  validate(rejectHandoffBodySchema, "json"),
  rejectHandoff
);

// Update visit status
router.put(
  "/:id/status",
  validate(getVisitParamsSchema, "param"),
  validate(updateVisitStatusSchema, "json"),
  updateVisitStatus
);

// Patient-flow: stage summary + atomic stage advance
router.get(
  "/:id/stage-summary",
  validate(getVisitParamsSchema, "param"),
  getStageSummary
);
router.post(
  "/:id/advance",
  validate(getVisitParamsSchema, "param"),
  validate(advanceVisitSchema, "json"),
  ...withAccess({ resource: "visits", action: "update" }),
  advanceVisitStage
);

// Prescriptions
router.post(
  "/prescription",
  ...withAccess({ resource: "prescription", action: "create" }),
  validate(createPrescriptionSchema, "json"),
  createPrescription
);

router.put(
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

// Spectacle prescriptions
router.post(
  "/spectacle-prescription",
  validate(createSpectaclePrescriptionSchema, "json"),
  createSpectaclePrescription
);
router.put(
  "/spectacle-prescription/:prescriptionId",
  validate(getPrescriptionParamsSchema, "param"),
  validate(updateSpectaclePrescriptionSchema, "json"),
  updateSpectaclePrescription
);

export default router;
