import { Hono } from "hono";
import { validateIdParamsSchema } from "@/lib/common-validation";
import { validate } from "@/middlewares/validation.middleware";
import { QueuesController } from "./queues.controller";
import { createQueueConfigSchema } from "./queues.validation";

const queuesRouter = new Hono();

// Configuration
queuesRouter.post(
  "/config",
  validate(createQueueConfigSchema, "json"),
  QueuesController.createConfig
);
queuesRouter.get("/config", QueuesController.listConfigs);
queuesRouter.put(
  "/config/:id",
  validate(validateIdParamsSchema, "param"),
  QueuesController.updateConfig
);
queuesRouter.delete(
  "/config/:id",
  validate(validateIdParamsSchema, "param"),
  QueuesController.deleteConfig
);

// Operations
queuesRouter.post("/:id/open", QueuesController.openQueue); // :id is configId
queuesRouter.post("/active/:id/close", QueuesController.closeQueue); // :id is queueId
queuesRouter.get("/active", QueuesController.listActiveQueues);
queuesRouter.put("/entries/:entryId/status", QueuesController.nextPatient);

export default queuesRouter;
