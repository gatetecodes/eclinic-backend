import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "@/lib/constants";
import { logger } from "@/lib/logger";

export function unauthorized(c: Context) {
  logger.warn("access_denied", { reason: "UNAUTHORIZED" });
  return c.json(
    { error: "Unauthorized", status: httpCodes.UNAUTHORIZED },
    httpCodes.UNAUTHORIZED as ContentfulStatusCode
  );
}

export function forbidden(
  c: Context,
  reason:
    | "RBAC_DENIED"
    | "FEATURE_DISABLED"
    | "TENANT_NOT_FOUND"
    | "QUOTA_EXCEEDED",
  extra?: Record<string, unknown>
) {
  logger.warn("access_denied", { reason, ...extra });
  return c.json(
    { error: "Forbidden", reason, ...extra },
    httpCodes.FORBIDDEN as ContentfulStatusCode
  );
}

export function internalServerError(c: Context) {
  logger.error("internal_server_error", { reason: "INTERNAL_SERVER_ERROR" });
  return c.json(
    { error: "Internal Server Error", status: httpCodes.INTERNAL_SERVER_ERROR },
    httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
  );
}
