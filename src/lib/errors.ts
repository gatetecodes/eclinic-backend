import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "@/lib/constants";
import { logger } from "@/lib/logger";

export function unauthorized(c: Context) {
  logger.warn("access_denied", { reason: "UNAUTHORIZED" });
  return c.json(
    {
      success: false,
      status: httpCodes.UNAUTHORIZED,
      error: { code: "UNAUTHORIZED", message: "Unauthorized" },
    },
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
    {
      success: false,
      status: httpCodes.FORBIDDEN,
      error: { code: "FORBIDDEN", message: "Forbidden" },
      ...extra,
    },
    httpCodes.FORBIDDEN as ContentfulStatusCode
  );
}

export function internalServerError(c: Context) {
  logger.error("internal_server_error", { reason: "INTERNAL_SERVER_ERROR" });
  return c.json(
    {
      success: false,
      status: httpCodes.INTERNAL_SERVER_ERROR,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Something went wrong",
      },
    },
    httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
  );
}
