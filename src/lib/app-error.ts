import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodError, ZodIssue } from "zod";
import { httpCodes } from "@/lib/constants";
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

  constructor(params: {
    status: number;
    code: string;
    message?: string;
    issues?: AppIssue[];
    exposeMessage?: boolean;
  }) {
    super(params.message ?? params.code);
    this.name = "AppError";
    this.status = params.status;
    this.code = params.code;
    this.issues = params.issues;
    this.exposeMessage = params.exposeMessage ?? params.status < 500;
  }

  toResponse(c: Context) {
    const payload = {
      success: false as const,
      status: this.status,
      error: {
        code: this.code,
        message: this.exposeMessage ? this.message : undefined,
        issues: this.issues,
      },
    };
    return c.json(payload, this.status as unknown as ContentfulStatusCode);
  }
}

export function fromZodError(error: ZodError): AppError {
  const issues: AppIssue[] = error.issues.map((issue: ZodIssue) => ({
    field: issue.path?.length ? String(issue.path.join(".")) : undefined,
    code: issue.code,
    message: issue.message,
  }));
  return new AppError({
    status: httpCodes.BAD_REQUEST,
    code: "VALIDATION_ERROR",
    message: "Validation failed",
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
    exposeMessage: true,
  });
}

export function unauthorizedError(message = "Unauthorized") {
  return new AppError({
    status: httpCodes.UNAUTHORIZED,
    code: "UNAUTHORIZED",
    message,
    exposeMessage: true,
  });
}

export function forbiddenError(message = "Forbidden") {
  return new AppError({
    status: httpCodes.FORBIDDEN,
    code: "FORBIDDEN",
    message,
    exposeMessage: true,
  });
}
