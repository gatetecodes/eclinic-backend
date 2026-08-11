import type { Hono } from "hono";
import type { AppEnv } from "../../../../middlewares/auth.middleware.ts";
import { validate } from "../../../../middlewares/validation.middleware.ts";
import { withAccess } from "../../../../middlewares/with-access.middleware.ts";
import {
  advanceVisitStage,
  createFlowCheckIn,
  getFlowConfig,
  getPipeline,
  getStageSummary,
  updateFlowConfig,
} from "../controllers/flow.controller.ts";
import {
  advanceVisitSchema,
  flowCheckInSchema,
  flowConfigUpdateSchema,
  getVisitParamsSchema,
} from "../visits.validation.ts";
import { createVisitRouteRegistrars } from "./register-route.ts";

export const registerFlowVisitRoutes = (router: Hono<AppEnv>): void => {
  const { get, post, put } = createVisitRouteRegistrars(router);

  get("/pipeline", getPipeline);
  get(
    "/flow/config",
    ...withAccess({ resource: "visits", action: "read" }),
    getFlowConfig
  );
  put(
    "/flow/config",
    validate(flowConfigUpdateSchema, "json"),
    ...withAccess({ resource: "clinics", action: "update" }),
    updateFlowConfig
  );
  post(
    "/flow/check-in",
    validate(flowCheckInSchema, "json"),
    ...withAccess({ resource: "visits", action: "create" }),
    createFlowCheckIn
  );
  get(
    "/:id/stage-summary",
    validate(getVisitParamsSchema, "param"),
    getStageSummary
  );
  post(
    "/:id/advance",
    validate(getVisitParamsSchema, "param"),
    validate(advanceVisitSchema, "json"),
    ...withAccess({ resource: "visits", action: "update" }),
    advanceVisitStage
  );
};
