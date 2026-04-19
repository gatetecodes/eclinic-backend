import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  createTranslator,
  type TranslationKey,
  type TranslationValues,
} from "@/lib/i18n";

type ResponseIssue = {
  field?: string;
  message: string;
  code?: string;
};

type ErrorResponseParams = {
  status: number;
  code: string;
  message?: string;
  messageKey?: TranslationKey;
  messageValues?: TranslationValues;
  issues?: ResponseIssue[];
  details?: unknown;
};

type SuccessResponseParams<T> = {
  status?: number;
  success?: boolean | string;
  message?: string;
  messageKey?: TranslationKey;
  messageValues?: TranslationValues;
  data?: T;
  meta?: Record<string, unknown>;
};

function getTranslator(c: Context) {
  return c.get("t") ?? createTranslator(c.get("locale"));
}

export function translateForContext(
  c: Context,
  key: TranslationKey,
  values?: TranslationValues
) {
  return getTranslator(c)(key, values);
}

export function jsonError(c: Context, params: ErrorResponseParams) {
  const t = getTranslator(c);
  const message = params.messageKey
    ? t(params.messageKey, params.messageValues)
    : params.message;

  c.header("Content-Language", c.get("locale") ?? "en");

  return c.json(
    {
      success: false,
      status: params.status,
      error: {
        code: params.code,
        message,
        messageKey: params.messageKey,
        issues: params.issues,
        details: params.details,
      },
    },
    params.status as ContentfulStatusCode
  );
}

export function jsonSuccess<T>(c: Context, params: SuccessResponseParams<T>) {
  const t = getTranslator(c);
  const status = params.status ?? 200;
  const message = params.messageKey
    ? t(params.messageKey, params.messageValues)
    : params.message;

  c.header("Content-Language", c.get("locale") ?? "en");

  return c.json(
    {
      ...(params.success === undefined
        ? { success: true }
        : { success: params.success }),
      ...(message ? { message } : {}),
      ...(params.data === undefined ? {} : { data: params.data }),
      ...(params.meta === undefined ? {} : { meta: params.meta }),
      status,
    },
    status as ContentfulStatusCode
  );
}
