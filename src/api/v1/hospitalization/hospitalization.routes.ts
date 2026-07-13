import { Hono } from "hono";
import z from "zod";
import { crudAccess } from "@/middlewares/crud-access.middleware";
import type { AppEnv } from "../../../middlewares/auth.middleware";
import { validate } from "../../../middlewares/validation.middleware";
import {
  addBeds,
  addMedication,
  addProgressNote,
  administerMedication,
  admitPatient,
  createWard,
  dischargePatient,
  getAdmission,
  getBill,
  getBoard,
  getHospitalizations,
  getWards,
  orderTest,
  recordObservation,
  transferAdmission,
  updateBed,
  updateOrder,
  updateWard,
} from "./hospitalization.controller";
import {
  addBedsSchema,
  administerSchema,
  admitSchema,
  createWardSchema,
  dischargeSchema,
  medicationSchema,
  observationSchema,
  orderSchema,
  progressNoteSchema,
  transferSchema,
  updateBedSchema,
  updateOrderSchema,
  updateWardSchema,
} from "./hospitalization.validation";

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const medIdParamSchema = z.object({
  medId: z.coerce.number().int().positive(),
});
const orderIdParamSchema = z.object({
  orderId: z.coerce.number().int().positive(),
});

const router = new Hono<AppEnv>();
router.use("*", crudAccess("visits", "hospitalization"));

// Bed board + roster
router.get("/board", getBoard);
router.get("/", getHospitalizations);

// Wards & beds administration
router.get("/wards", getWards);
router.post("/wards", validate(createWardSchema, "json"), createWard);
router.patch(
  "/wards/:id",
  validate(idParamSchema, "param"),
  validate(updateWardSchema, "json"),
  updateWard
);
router.post(
  "/wards/:id/beds",
  validate(idParamSchema, "param"),
  validate(addBedsSchema, "json"),
  addBeds
);
router.patch(
  "/beds/:id",
  validate(idParamSchema, "param"),
  validate(updateBedSchema, "json"),
  updateBed
);

// Admissions
router.post("/", validate(admitSchema, "json"), admitPatient);
router.get("/:id", validate(idParamSchema, "param"), getAdmission);
router.get("/:id/bill", validate(idParamSchema, "param"), getBill);
router.post(
  "/:id/transfer",
  validate(idParamSchema, "param"),
  validate(transferSchema, "json"),
  transferAdmission
);
router.post(
  "/:id/observations",
  validate(idParamSchema, "param"),
  validate(observationSchema, "json"),
  recordObservation
);
router.post(
  "/:id/medications",
  validate(idParamSchema, "param"),
  validate(medicationSchema, "json"),
  addMedication
);
router.post(
  "/medications/:medId/administer",
  validate(medIdParamSchema, "param"),
  validate(administerSchema, "json"),
  administerMedication
);
router.post(
  "/:id/notes",
  validate(idParamSchema, "param"),
  validate(progressNoteSchema, "json"),
  addProgressNote
);
router.post(
  "/:id/orders",
  validate(idParamSchema, "param"),
  validate(orderSchema, "json"),
  orderTest
);
router.patch(
  "/orders/:orderId",
  validate(orderIdParamSchema, "param"),
  validate(updateOrderSchema, "json"),
  updateOrder
);
router.post(
  "/:id/discharge",
  validate(idParamSchema, "param"),
  validate(dischargeSchema, "json"),
  dischargePatient
);

export default router;
