import { Hono } from "hono";
import { PublicController } from "./public.controller";
import { QueuesController } from "./queues.controller";

const publicQueuesRouter = new Hono();

// Discovery
publicQueuesRouter.get("/search", PublicController.searchClinics);
publicQueuesRouter.get(
  "/clinics/:clinicId/services",
  PublicController.getClinicQueues
);
publicQueuesRouter.post("/patients/check", PublicController.checkPatient);

// Actions
publicQueuesRouter.get("/qr/:token", PublicController.resolveQrToken);
publicQueuesRouter.get("/config/:slug", QueuesController.getPublicClinic);
publicQueuesRouter.post("/:id/join", QueuesController.joinQueuePublic); // :id is active Queue ID? Or Config ID? Controller implementation assumes active Queue ID.
publicQueuesRouter.get("/entry/:id", QueuesController.getEntryStatus);

export default publicQueuesRouter;
