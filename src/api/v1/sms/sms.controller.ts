import type { Context } from "hono";
import { logger } from "@/lib/logger";
import { SmsService } from "@/services/sms.service";
import { TwilioProvider } from "@/services/twilio.provider";

export const smsStatusWebhook = async (c: Context) => {
  try {
    const parsed = await c.req.parseBody();
    const signatureHeader = c.req.header("x-twilio-signature");
    const rawBody = Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [
        key,
        typeof value === "string" ? value : "",
      ])
    );

    const isValidSignature = TwilioProvider.verifyWebhookSignature({
      fullUrl: c.req.url,
      rawBody,
      signatureHeader,
    });

    if (!isValidSignature) {
      logger.warn("Twilio webhook signature validation failed");
      return c.text("unauthorized", 401);
    }

    const messageSid = parsed.MessageSid;
    const messageStatus = parsed.MessageStatus;
    const errorCode = parsed.ErrorCode;
    const errorMessage = parsed.ErrorMessage;

    await SmsService.handleStatusCallback({
      messageSid: typeof messageSid === "string" ? messageSid : undefined,
      messageStatus:
        typeof messageStatus === "string" ? messageStatus : undefined,
      errorCode: typeof errorCode === "string" ? errorCode : undefined,
      errorMessage: typeof errorMessage === "string" ? errorMessage : undefined,
    });

    return c.text("ok", 200);
  } catch (error) {
    logger.error("SMS status webhook failed", { error });
    return c.text("error", 500);
  }
};
