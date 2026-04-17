import type { Context } from "hono";
import { jsonError } from "@/lib/api-response";
import { httpCodes } from "@/lib/constants";
import type { TranslationKey } from "@/lib/i18n";
import { logger } from "@/lib/logger";

export function unauthorized(c: Context) {
  logger.warn("access_denied", { reason: "UNAUTHORIZED" });
  return jsonError(c, {
    status: httpCodes.UNAUTHORIZED,
    code: "UNAUTHORIZED",
    messageKey: "common.unauthorized",
  });
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
  const messageKeys: Record<typeof reason, TranslationKey> = {
    RBAC_DENIED: "errors.rbacDenied",
    FEATURE_DISABLED: "errors.featureDisabled",
    TENANT_NOT_FOUND: "errors.tenantNotFound",
    QUOTA_EXCEEDED: "errors.quotaExceeded",
  };

  return jsonError(c, {
    status: httpCodes.FORBIDDEN,
    code: "FORBIDDEN",
    messageKey: messageKeys[reason] ?? "common.forbidden",
    details: extra,
  });
}

export function internalServerError(c: Context) {
  logger.error("internal_server_error", { reason: "INTERNAL_SERVER_ERROR" });
  return jsonError(c, {
    status: httpCodes.INTERNAL_SERVER_ERROR,
    code: "INTERNAL_SERVER_ERROR",
    messageKey: "common.internalServerError",
  });
}
