import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import { registerClinicalVisitRoutes } from "./routes/clinical.routes.ts";
import { registerFlowVisitRoutes } from "./routes/flow.routes.ts";
import { registerPrescriptionVisitRoutes } from "./routes/prescription.routes.ts";
import { registerReceptionVisitRoutes } from "./routes/reception.routes.ts";

const router: Hono<AppEnv> = new Hono<AppEnv>();

registerFlowVisitRoutes(router);
registerReceptionVisitRoutes(router);
registerClinicalVisitRoutes(router);
registerPrescriptionVisitRoutes(router);

export default router;
