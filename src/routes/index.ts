import { Hono } from "hono";

// Versioned API routers will be mounted here
import v1Router from "../api/v1";

const router = new Hono();

// Mount at /v1 and at root to preserve existing /api/* endpoints when ported
router.route("/v1", v1Router);
router.route("/", v1Router);

export default router;
