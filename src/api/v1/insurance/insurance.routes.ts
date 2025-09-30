import { Hono } from "hono";
import { validate } from "@/middlewares/validation.middleware.ts";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { crudAccess } from "../../../middlewares/crud-access.middleware.ts";
import {
  createNewEmployer,
  createNewInsuranceCompany,
  createNewPatientInsurance,
  getEmployersList,
  getInsuranceByNumber,
  getInsuranceByPatientId,
  getInsuranceCompaniesList,
} from "./insurance.controller.ts";
import {
  employerSchema,
  insuranceCompanySchema,
  patientInsuranceSchema,
} from "./insurance.validation.ts";

const router = new Hono<AppEnv>();
router.use("*", crudAccess("insurance", "insuranceClaims"));

router.get("/employers", getEmployersList);
router.get("/insurance-companies", getInsuranceCompaniesList);
router.get("/by-number/:insuranceNumber", getInsuranceByNumber);
router.get("/by-patient/:patientId", getInsuranceByPatientId);
router.post(
  "/insurance-company",
  validate(insuranceCompanySchema, "json"),
  createNewInsuranceCompany
);
router.post("/employer", validate(employerSchema, "json"), createNewEmployer);
router.post(
  "/patient-insurance",
  validate(patientInsuranceSchema, "json"),
  createNewPatientInsurance
);

export default router;
