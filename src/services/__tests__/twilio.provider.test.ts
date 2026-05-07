import { afterEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { normalizeToE164, TwilioProvider } from "@/services/twilio.provider";

const ORIGINAL_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const ORIGINAL_VALIDATE_FLAG = process.env.TWILIO_VALIDATE_WEBHOOK_SIGNATURE;

afterEach(() => {
  process.env.TWILIO_AUTH_TOKEN = ORIGINAL_AUTH_TOKEN;
  process.env.TWILIO_VALIDATE_WEBHOOK_SIGNATURE = ORIGINAL_VALIDATE_FLAG;
});

describe("normalizeToE164", () => {
  it("normalizes Rwanda local numbers", () => {
    expect(normalizeToE164("0781234567")).toBe("+250781234567");
  });

  it("normalizes Rwanda international number without plus", () => {
    expect(normalizeToE164("250781234567")).toBe("+250781234567");
  });

  it("accepts valid E.164 numbers", () => {
    expect(normalizeToE164("+14155552671")).toBe("+14155552671");
  });

  it("rejects invalid or empty values", () => {
    expect(normalizeToE164("")).toBeNull();
    expect(normalizeToE164("abc")).toBeNull();
  });
});

describe("verifyWebhookSignature", () => {
  it("verifies a valid Twilio signature", () => {
    process.env.TWILIO_AUTH_TOKEN = "test_token";
    process.env.TWILIO_VALIDATE_WEBHOOK_SIGNATURE = "true";

    const fullUrl = "https://api.example.com/api/v1/sms/webhook/status";
    const rawBody = {
      MessageSid: "SM123",
      MessageStatus: "delivered",
    };
    const payload = `${fullUrl}MessageSidSM123MessageStatusdelivered`;
    const signatureHeader = createHmac("sha1", "test_token")
      .update(payload)
      .digest("base64");

    const isValid = TwilioProvider.verifyWebhookSignature({
      fullUrl,
      rawBody,
      signatureHeader,
    });

    expect(isValid).toBeTrue();
  });

  it("fails invalid signatures when validation is enabled", () => {
    process.env.TWILIO_AUTH_TOKEN = "test_token";
    process.env.TWILIO_VALIDATE_WEBHOOK_SIGNATURE = "true";

    const isValid = TwilioProvider.verifyWebhookSignature({
      fullUrl: "https://api.example.com/api/v1/sms/webhook/status",
      rawBody: { MessageSid: "SM123" },
      signatureHeader: "invalid_signature",
    });

    expect(isValid).toBeFalse();
  });
});
