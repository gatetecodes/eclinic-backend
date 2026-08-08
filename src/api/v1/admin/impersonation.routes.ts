import { Hono } from "hono";
import type { AppEnv } from "../../../middlewares/auth.middleware.ts";
import {
  getImpersonationStatus,
  stopImpersonation,
} from "./impersonation.controller.ts";

/**
 * Impersonation exit + status, mounted OUTSIDE the operator-gated /admin router.
 *
 * While impersonating, `c.get("user")` is the tenant account, so `requireSuperAdmin`
 * would reject these two requests — the operator could enter an impersonation but
 * never leave it. Authorisation instead comes from the session itself carrying
 * `impersonatedBy`, which only the auth layer can set.
 *
 * Mounted before tenantContext as well, so the exit path does not depend on the
 * impersonated account resolving to a clinic.
 */
const router = new Hono<AppEnv>();

router.get("/status", getImpersonationStatus);
router.post("/stop", stopImpersonation);

export default router;
