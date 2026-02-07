import { Hono } from "hono";
import { verifyRecaptcha } from "@/middlewares/recaptcha.middleware";
import { PublicController } from "./public.controller";
import { QueuesController } from "./queues.controller";

const publicQueuesRouter = new Hono();

// Discovery
publicQueuesRouter.get("/search", PublicController.searchClinics);
publicQueuesRouter.get(
  "/clinics/:clinicId/services",
  PublicController.getClinicQueues
);
publicQueuesRouter.post(
  "/patients/check",
  verifyRecaptcha({ expectedAction: "queueless_patient_check", minScore: 0.7 }),
  PublicController.checkPatient
);

// Actions
publicQueuesRouter.get("/qr/:token", PublicController.resolveQrToken);
publicQueuesRouter.get("/config/:slug", QueuesController.getPublicClinic);
publicQueuesRouter.post(
  "/:id/join",
  verifyRecaptcha({ expectedAction: "queueless_queue_join" }),
  QueuesController.joinQueuePublic
); // :id is active Queue ID? Or Config ID? Controller implementation assumes active Queue ID.
publicQueuesRouter.get("/entry/:id", QueuesController.getEntryStatus);

export default publicQueuesRouter;
