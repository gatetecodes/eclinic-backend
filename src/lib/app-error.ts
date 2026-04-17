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
    return jsonError(c, {
      status: this.status,
      code: this.code,
      message: this.exposeMessage ? this.message : undefined,
      messageKey: this.exposeMessage ? this.messageKey : undefined,
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

export function notFoundError(message = "Not Found") {
  return new AppError({
    status: httpCodes.NOT_FOUND,
    code: "NOT_FOUND",
    message,
    messageKey: "common.notFound",
    exposeMessage: true,
  });
}

export function unauthorizedError(message = "Unauthorized") {
  return new AppError({
    status: httpCodes.UNAUTHORIZED,
    code: "UNAUTHORIZED",
    message,
    messageKey: "common.unauthorized",
    exposeMessage: true,
  });
}

export function forbiddenError(message = "Forbidden") {
  return new AppError({
    status: httpCodes.FORBIDDEN,
    code: "FORBIDDEN",
    message,
    messageKey: "common.forbidden",
    exposeMessage: true,
  });
}
