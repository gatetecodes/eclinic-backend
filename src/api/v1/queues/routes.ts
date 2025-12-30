import { Hono } from "hono";
import { QueuesController } from "./queues.controller";

const queuesRouter = new Hono();

// Configuration
queuesRouter.post("/config", QueuesController.createConfig);
queuesRouter.get("/config", QueuesController.listConfigs);

// Operations
queuesRouter.post("/:id/open", QueuesController.openQueue); // :id is configId
queuesRouter.post("/active/:id/close", QueuesController.closeQueue); // :id is queueId
queuesRouter.get("/active", QueuesController.listActiveQueues);
queuesRouter.patch("/entries/:entryId/status", QueuesController.nextPatient);

export default queuesRouter;
