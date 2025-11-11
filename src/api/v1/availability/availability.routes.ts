import { Hono } from "hono";
import type { AppEnv } from "@/middlewares/auth.middleware.ts";
import { crudAccess } from "@/middlewares/crud-access.middleware.ts";
import { validate } from "@/middlewares/validation.middleware.ts";
import { getAvailabilityByUserId } from "./availability.controller.ts";
import {
  availabilityParamSchema,
  availabilityQuerySchema,
} from "./availability.validation.ts";

const router = new Hono<AppEnv>();
router.use("*", crudAccess("appointments", "visits"));

router.get(
  "/:userId",
  validate(availabilityParamSchema, "param"),
  validate(availabilityQuerySchema, "query"),
  getAvailabilityByUserId
);

export default router;
