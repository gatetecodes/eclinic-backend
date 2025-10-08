import { Hono } from "hono";
import z from "zod";
import { crudAccess } from "@/middlewares/crud-access.middleware";
import type { AppEnv } from "../../../middlewares/auth.middleware";
import { validate } from "../../../middlewares/validation.middleware";
import {
  addHospitalizationProducts,
  addHospitalizationRoom,
  dischargePatient,
  getHospitalizationRoomPrices,
  getHospitalizationRooms,
  getHospitalizations,
  hospitalizePatient,
  setHospitalizationRoomPrice,
} from "./hospitalization.controller";
import {
  addProductSchema,
  hospitalizeSchema,
  roomPriceSchema,
  roomSchema,
} from "./hospitalization.validation";

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

const router = new Hono<AppEnv>();
router.use("*", crudAccess("visits", "hospitalization"));
router.get("/", getHospitalizations);
router.post("/", validate(hospitalizeSchema, "json"), hospitalizePatient);
router.get("/rooms", getHospitalizationRooms);
router.get("/room-prices", getHospitalizationRoomPrices);
router.post("/rooms", validate(roomSchema, "json"), addHospitalizationRoom);
router.post(
  "/room-prices",
  validate(roomPriceSchema, "json"),
  setHospitalizationRoomPrice
);
router.post(
  "/:id/discharge",
  validate(idParamSchema, "param"),
  dischargePatient
);
router.post(
  "/:id/products",
  validate(idParamSchema, "param"),
  validate(addProductSchema, "json"),
  addHospitalizationProducts
);

export default router;
