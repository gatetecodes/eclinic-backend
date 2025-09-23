import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth";
import { validate } from "../../../middlewares/validation.middleware";
// core controllers
// core controllers
import {
  addPaymentMethod,
  createConsultationNote,
  createInitialCheckIn,
  dischargeVisit,
  editChiefComplaint,
  editConsultationNote,
  finalizeVisit,
  getPatientVisits,
  getVisitById,
  listVisits,
  updatePreConsultation,
  updateVisitStatus,
} from "./controllers/core.controller.ts";
// exams controllers (migrated out for maintainability)
import {
  addExams,
  addNurseTreatment,
  addTreatment,
  editVisitExams,
  getVisitExam,
  markResultsReady,
} from "./controllers/exams.controller.ts";
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
  consultationNoteSchema,
  editChiefComplaintSchema,
  editVisitExamsBodySchema,
  finalizeVisitSchema,
  getHandoffParamsSchema,
  getPatientVisitsParamsSchema,
  getVisitParamsSchema,
  handoffSchema,
  initialCheckInSchema,
  rejectHandoffBodySchema,
  updatePreConsultationRequestSchema,
  updateVisitStatusSchema,
} from "./visits.validation.ts";

const router = new Hono<AppEnv>();

router.get("/", listVisits);
router.get("/:id", validate(getVisitParamsSchema, "param"), getVisitById);

// New parity endpoints
router.post(
  "/check-in",
  validate(initialCheckInSchema, "json"),
  createInitialCheckIn
);
router.put(
  "/:id/pre-consultation",
  validate(getVisitParamsSchema, "param"),
  validate(updatePreConsultationRequestSchema, "json"),
  updatePreConsultation
);

// Payment mode
router.post(
  "/:id/payment-mode",
  validate(getVisitParamsSchema, "param"),
  validate(addPaymentMethodSchema, "json"),
  addPaymentMethod
);

// Exams
router.post(
  "/:id/exams",
  validate(getVisitParamsSchema, "param"),
  validate(addExamsSchema, "json"),
  addExams
);
router.get("/:id/exam", validate(getVisitParamsSchema, "param"), getVisitExam);

// Results ready
router.post(
  "/:id/results-ready",
  validate(getVisitParamsSchema, "param"),
  markResultsReady
);

// Transfer to doctor
router.post(
  "/:id/transfer",
  validate(getVisitParamsSchema, "param"),
  transferVisitToDoctor
);

// Edit exams
router.put(
  "/:id/exams",
  validate(getVisitParamsSchema, "param"),
  validate(editVisitExamsBodySchema, "json"),
  editVisitExams
);

// Visits with prescriptions
router.get("/with-prescriptions", getVisitsWithPrescriptions);

// Today's visits
router.get("/today", getTodaysVisits);

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

// Treatments
router.post(
  "/:id/treatments",
  validate(getVisitParamsSchema, "param"),
  validate(addVisitTreatmentBodySchema, "json"),
  addTreatment
);
router.post(
  "/:id/nurse-treatments",
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

export default router;
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
