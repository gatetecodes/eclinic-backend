import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "@/lib/logger";

type TwilioSendResult = {
  success: boolean;
  providerMessageId?: string;
  status?: string;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
};

const TWILIO_RETRYABLE_CODES = new Set([
  "20429", // Too many requests
  "21612", // Message cannot be sent because queue is full
  "30001", // Queue overflow
  "30002", // Account suspended / temporary issue
  "30003", // Unreachable carrier (transient in some regions)
  "30008", // Unknown error from downstream
]);

const E164_REGEX = /^\+[1-9]\d{6,14}$/;

function isRetryableError(httpStatus: number, code?: string): boolean {
  if (httpStatus >= 500) {
    return true;
  }
  if (httpStatus === 429) {
    return true;
  }
  if (code && TWILIO_RETRYABLE_CODES.has(code)) {
    return true;
  }
  return false;
}

function safeCompare(a: string, b: string): boolean {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  if (first.length !== second.length) {
    return false;
  }
  return timingSafeEqual(first, second);
}

export function normalizeToE164(rawPhone: string): string | null {
  const trimmed = rawPhone.trim();
  if (!trimmed) {
    return null;
  }

  // Already in E.164 format
  if (E164_REGEX.test(trimmed)) {
    return trimmed;
  }

  const digits = trimmed.replace(/\D/g, "");
  if (!digits) {
    return null;
  }

  // Rwanda local (07XXXXXXXX)
  if (digits.length === 10 && digits.startsWith("07")) {
    return `+250${digits.slice(1)}`;
  }

  // Rwanda international without +
  if (digits.length === 12 && digits.startsWith("250")) {
    return `+${digits}`;
  }

  // Generic fallback if length is plausible for E.164
  if (digits.length >= 7 && digits.length <= 15) {
    return `+${digits}`;
  }

  return null;
}

export const TwilioProvider = {
  verifyWebhookSignature: (params: {
    fullUrl: string;
    rawBody: Record<string, string>;
    signatureHeader?: string;
  }): boolean => {
    if (process.env.TWILIO_VALIDATE_WEBHOOK_SIGNATURE === "false") {
      return true;
    }

    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
      logger.warn("Twilio webhook signature check skipped: auth token missing");
      return true;
    }

    if (!params.signatureHeader) {
      return false;
    }

    const sortedKeys = Object.keys(params.rawBody).sort();
    const payload = sortedKeys.reduce(
      (acc, key) => `${acc}${key}${params.rawBody[key] ?? ""}`,
      params.fullUrl
    );

    const expected = createHmac("sha1", authToken)
      .update(payload)
      .digest("base64");

    return safeCompare(expected, params.signatureHeader);
  },

  sendMessage: async (params: {
    to: string;
    body: string;
    statusCallbackUrl?: string;
    //biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
  }): Promise<TwilioSendResult> => {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
    const alphanumericSenderId = process.env.TWILIO_ALPHANUMERIC_SENDER_ID;
    const from = process.env.TWILIO_FROM || process.env.TWILIO_FROM_NUMBER;

    if (!(accountSid && authToken)) {
      logger.error("Twilio credentials are not configured", {
        hasSid: Boolean(accountSid),
        hasToken: Boolean(authToken),
      });
      return {
        success: false,
        errorMessage: "Twilio credentials are not configured",
        retryable: false,
      };
    }

    if (!(messagingServiceSid || alphanumericSenderId || from)) {
      logger.error("Twilio sender configuration missing", {
        hasMessagingService: Boolean(messagingServiceSid),
        hasAlphanumericSenderId: Boolean(alphanumericSenderId),
        hasFrom: Boolean(from),
      });
      return {
        success: false,
        errorMessage: "Twilio sender configuration missing",
        retryable: false,
      };
    }

    const bodyParams = new URLSearchParams();
    bodyParams.set("To", params.to);
    bodyParams.set("Body", params.body);
    if (messagingServiceSid) {
      bodyParams.set("MessagingServiceSid", messagingServiceSid);
    } else if (alphanumericSenderId) {
      bodyParams.set("From", alphanumericSenderId.trim());
    } else if (from) {
      bodyParams.set("From", from);
    }
    if (params.statusCallbackUrl) {
      bodyParams.set("StatusCallback", params.statusCallbackUrl);
    }

    const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString(
      "base64"
    );

    try {
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${basicAuth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: bodyParams.toString(),
        }
      );

      const json = (await response.json().catch(() => ({}))) as {
        sid?: string;
        status?: string;
        code?: number;
        message?: string;
      };

      if (!response.ok) {
        const code = json.code ? String(json.code) : undefined;
        const retryable = isRetryableError(response.status, code);
        logger.error("Twilio SMS send failed", {
          to: params.to,
          status: response.status,
          code,
          message: json.message,
          retryable,
        });

        return {
          success: false,
          errorCode: code,
          errorMessage: json.message || "Failed to send SMS",
          retryable,
        };
      }

      logger.info("Twilio SMS queued", {
        to: params.to,
        providerMessageId: json.sid,
        status: json.status,
      });

      return {
        success: true,
        providerMessageId: json.sid,
        status: json.status,
      };
    } catch (error) {
      logger.error("Twilio SMS request crashed", {
        to: params.to,
        error,
      });
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
  },
};
