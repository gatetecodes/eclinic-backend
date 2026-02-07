import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "@/lib/constants";
import { verifyRecaptchaToken } from "@/lib/recaptcha";

type VerifyRecaptchaOptions = {
  minScore?: number;
  expectedAction?: string;
};

const DEFAULT_MIN_SCORE = 0.5;

export const verifyRecaptcha = (options?: VerifyRecaptchaOptions) =>
  createMiddleware(async (c, next) => {
    if (process.env.RECAPTCHA_ENABLED === "false") {
      await next();
      return;
    }

    const token = c.req.header("x-recaptcha-token");

    if (!token) {
      return c.json(
        {
          success: false,
          status: httpCodes.BAD_REQUEST,
          error: {
            code: "RECAPTCHA_MISSING_TOKEN",
            message: "Missing reCAPTCHA token.",
          },
        },
        httpCodes.BAD_REQUEST as ContentfulStatusCode
      );
    }

    const remoteIp =
      c.req.header("x-forwarded-for") ??
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-real-ip") ??
      c.req.header("x-client-ip") ??
      null;

    const result = await verifyRecaptchaToken(token, remoteIp);

    if (!result.success) {
      return c.json(
        {
          success: false,
          status: httpCodes.FORBIDDEN,
          error: {
            code: "RECAPTCHA_VERIFICATION_FAILED",
            message: "Failed reCAPTCHA verification.",
            details: result.errors,
          },
        },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;

    if (typeof result.score === "number" && result.score < minScore) {
      return c.json(
        {
          success: false,
          status: httpCodes.FORBIDDEN,
          error: {
            code: "RECAPTCHA_LOW_SCORE",
            message: "Suspicious activity detected.",
            score: result.score,
          },
        },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    if (
      options?.expectedAction &&
      (result.action === undefined || result.action !== options.expectedAction)
    ) {
      return c.json(
        {
          success: false,
          status: httpCodes.FORBIDDEN,
          error: {
            code: "RECAPTCHA_UNEXPECTED_ACTION",
            message: "Unexpected reCAPTCHA action.",
          },
        },
        httpCodes.FORBIDDEN as ContentfulStatusCode
      );
    }

    await next();
  });
