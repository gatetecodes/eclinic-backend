import type { Context } from "hono";
import type { ZodError, ZodIssue } from "zod";
import { jsonError } from "@/lib/api-response";
import { httpCodes } from "@/lib/constants";
import {
  type TranslationKey,
  type TranslationValues,
  translateZodIssue,
} from "@/lib/i18n";
import { logger } from "@/lib/logger";

export type AppIssue = {
  field?: string;
  message: string;
  code?: string;
};

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues?: AppIssue[];
  readonly exposeMessage: boolean;
  readonly messageKey?: TranslationKey;
  readonly messageValues?: TranslationValues;

  constructor(params: {
    status: number;
    code: string;
    message?: string;
    issues?: AppIssue[];
    exposeMessage?: boolean;
    messageKey?: TranslationKey;
    messageValues?: TranslationValues;
  }) {
    super(params.message ?? params.code);
    this.name = "AppError";
    this.status = params.status;
    this.code = params.code;
    this.issues = params.issues;
    this.exposeMessage = params.exposeMessage ?? params.status < 500;
    this.messageKey = params.messageKey;
    this.messageValues = params.messageValues;
  }

  toResponse(c: Context) {
    const messageKey = this.exposeMessage ? this.messageKey : undefined;
    return jsonError(c, {
      status: this.status,
      code: this.code,
      message: messageKey
        ? undefined
        : //biome-ignore lint/style/noNestedTernary: <>
          this.exposeMessage
          ? this.message
          : undefined,
      messageKey,
      messageValues: this.messageValues,
      issues: this.issues,
    });
  }
}

export function fromZodError(error: ZodError, c?: Context): AppError {
  const locale = c?.get("locale");
  const issues: AppIssue[] = error.issues.map((issue: ZodIssue) => ({
    field: issue.path?.length ? String(issue.path.join(".")) : undefined,
    code: issue.code,
    message: translateZodIssue(locale, issue),
  }));
  return new AppError({
    status: httpCodes.BAD_REQUEST,
    code: "VALIDATION_ERROR",
    message: "Validation failed",
    messageKey: "common.validationFailed",
    issues,
    exposeMessage: true,
  });
}

// Narrow Prisma known request errors lazily to avoid hard dep in this module
type MaybePrismaError = {
  code?: string;
  meta?: Record<string, unknown>;
  message?: string;
  name?: string;
};

/**
 * True when `error` is a Prisma unique-constraint violation (P2002) reported
 * against an index covering every one of `fields`.
 *
 * Callers use this to recognise a specific race — a check-then-write that lost —
 * and recover from it, rather than letting the global handler turn it into a
 * generic 409. `meta.target` is the field list on some driver adapters and the
 * constraint name on others, so both are matched by substring.
 */
export function isUniqueViolationOn(
  error: unknown,
  fields: readonly string[]
): boolean {
  const e = error as MaybePrismaError;
  if (!e || typeof e !== "object" || e.code !== "P2002") {
    return false;
  }
  const target = e.meta?.target;
  const described = (Array.isArray(target) ? target : [target])
    .filter((entry): entry is string => typeof entry === "string")
    .join(",");
  return fields.every((field) => described.includes(field));
}

export function tryMapPrismaError(error: unknown): AppError | null {
  const e = error as MaybePrismaError;
  if (!e || typeof e !== "object" || !e.code) {
    return null;
  }
  // Unique constraint violation
  if (e.code === "P2002") {
    logger.warn("prisma_unique_violation", { meta: e.meta });
    return new AppError({
      status: httpCodes.CONFLICT,
      code: "UNIQUE_CONSTRAINT_VIOLATION",
      message: "A record with the same unique value already exists",
      messageKey: "errors.uniqueConstraintViolation",
      exposeMessage: true,
    });
  }
  return null;
}

export function notFoundError(message?: string) {
  return new AppError({
    status: httpCodes.NOT_FOUND,
    code: "NOT_FOUND",
    message: message ?? "Not Found",
    messageKey: message ? undefined : "common.notFound",
    exposeMessage: true,
  });
}

export function unauthorizedError(message?: string) {
  return new AppError({
    status: httpCodes.UNAUTHORIZED,
    code: "UNAUTHORIZED",
    message: message ?? "Unauthorized",
    messageKey: message ? undefined : "common.unauthorized",
    exposeMessage: true,
  });
}

export function forbiddenError(message?: string) {
  return new AppError({
    status: httpCodes.FORBIDDEN,
    code: "FORBIDDEN",
    message: message ?? "Forbidden",
    messageKey: message ? undefined : "common.forbidden",
    exposeMessage: true,
  });
}
