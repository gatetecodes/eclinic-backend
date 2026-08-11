import { Hono } from "hono";

// Versioned API routers will be mounted here
import v1Router from "../api/v1";

const router = new Hono();

const mount = (path: string, childRouter: unknown) => {
  router.route(path, childRouter as Hono);
};

// Mount at /v1 and at root to preserve existing /api/* endpoints when ported
mount("/v1", v1Router);
mount("/", v1Router);

export default router;
