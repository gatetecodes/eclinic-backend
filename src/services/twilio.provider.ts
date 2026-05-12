import twilio from "twilio";
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
const DR_CONGO_COUNTRY_CODE = "243";
const DR_CONGO_NATIONAL_NUMBER_REGEX = /^[89]\d{8}$/;

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

  const drCongoPhone = normalizeDrCongoDigitsToE164(digits);
  if (drCongoPhone) {
    return drCongoPhone;
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

function normalizeDrCongoDigitsToE164(digits: string): string | null {
  if (
    digits.length === 14 &&
    digits.startsWith(`00${DR_CONGO_COUNTRY_CODE}`) &&
    DR_CONGO_NATIONAL_NUMBER_REGEX.test(digits.slice(5))
  ) {
    return `+${digits.slice(2)}`;
  }

  if (
    digits.length === 12 &&
    digits.startsWith(DR_CONGO_COUNTRY_CODE) &&
    DR_CONGO_NATIONAL_NUMBER_REGEX.test(digits.slice(3))
  ) {
    return `+${digits}`;
  }

  if (
    digits.length === 10 &&
    digits.startsWith("0") &&
    DR_CONGO_NATIONAL_NUMBER_REGEX.test(digits.slice(1))
  ) {
    return `+${DR_CONGO_COUNTRY_CODE}${digits.slice(1)}`;
  }

  if (digits.length === 9 && DR_CONGO_NATIONAL_NUMBER_REGEX.test(digits)) {
    return `+${DR_CONGO_COUNTRY_CODE}${digits}`;
  }

  return null;
}

export function normalizeDrCongoPhoneToE164(rawPhone: string): string | null {
  const digits = rawPhone.trim().replace(/\D/g, "");
  if (!digits) {
    return null;
  }
  return normalizeDrCongoDigitsToE164(digits);
}

export function isDrCongoPhoneNumber(rawPhone: string): boolean {
  return normalizeDrCongoPhoneToE164(rawPhone) !== null;
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

    return twilio.validateRequest(
      authToken,
      params.signatureHeader,
      params.fullUrl,
      params.rawBody
    );
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
        errorMessage:
          "Twilio sender missing: set TWILIO_MESSAGING_SERVICE_SID (recommended; configure alphanumeric sender on the service in Twilio)",
        retryable: false,
      };
    }

    const payload: {
      to: string;
      body: string;
      messagingServiceSid?: string;
      from?: string;
      statusCallback?: string;
    } = {
      to: params.to,
      body: params.body,
    };
    // Messaging Service wins: alphanumeric / pool is resolved by Twilio from the service.
    if (messagingServiceSid) {
      payload.messagingServiceSid = messagingServiceSid;
    } else if (alphanumericSenderId) {
      payload.from = alphanumericSenderId.trim();
    } else if (from) {
      payload.from = from;
    }
    if (params.statusCallbackUrl) {
      payload.statusCallback = params.statusCallbackUrl;
    }

    const client = twilio(accountSid, authToken);

    try {
      const message = await client.messages.create(payload);

      logger.info("Twilio SMS queued", {
        to: params.to,
        providerMessageId: message.sid,
        status: message.status,
      });

      return {
        success: true,
        providerMessageId: message.sid,
        status: message.status,
      };
    } catch (error) {
      const maybeError = error as {
        status?: number;
        code?: number | string;
        message?: string;
      };
      const errorCode = maybeError.code ? String(maybeError.code) : undefined;
      const retryable =
        typeof maybeError.status === "number"
          ? isRetryableError(maybeError.status, errorCode)
          : true;

      logger.error("Twilio SMS send failed", {
        to: params.to,
        status: maybeError.status,
        code: errorCode,
        message: maybeError.message,
        retryable,
        error,
      });
      return {
        success: false,
        errorCode,
        errorMessage:
          maybeError.message ||
          (error instanceof Error ? error.message : String(error)),
        retryable,
      };
    }
  },
};
