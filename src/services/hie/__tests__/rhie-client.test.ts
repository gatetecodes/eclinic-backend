import { afterEach, describe, expect, it } from "bun:test";
import {
  RhieRequestError,
  readBoundedJson,
  requestTimeoutMs,
} from "../rhie-client";

const originalRequestTimeout = process.env.HIE_REQUEST_TIMEOUT_MS;

afterEach(() => {
  process.env.HIE_REQUEST_TIMEOUT_MS = originalRequestTimeout;
});

describe("requestTimeoutMs", () => {
  it.each([undefined, "", "0", "-1", "60001", "Infinity", "not-a-number"])(
    "uses the default for invalid configured value %j",
    (configuredTimeout) => {
      process.env.HIE_REQUEST_TIMEOUT_MS = configuredTimeout;
      expect(requestTimeoutMs()).toBe(8000);
    }
  );

  it.each([
    ["1", 1],
    ["2500", 2500],
    ["60000", 60_000],
  ])("accepts configured value %s", (configuredTimeout, expected) => {
    process.env.HIE_REQUEST_TIMEOUT_MS = configuredTimeout;
    expect(requestTimeoutMs()).toBe(expected);
  });
});

describe("readBoundedJson", () => {
  it("rejects a non-numeric content-length header", async () => {
    const response = new Response("{}", {
      status: 502,
      headers: { "content-length": "not-a-number" },
    });

    await expect(readBoundedJson(response)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      status: 502,
      retryable: true,
    });
  });

  it("preserves the oversized-response error for a declared large body", async () => {
    const response = new Response("{}", {
      status: 200,
      headers: { "content-length": String(2 * 1024 * 1024 + 1) },
    });

    await expect(readBoundedJson(response)).rejects.toMatchObject({
      message: "RHIE response exceeded the configured size limit",
      code: "RESPONSE_TOO_LARGE",
      status: 200,
      retryable: false,
    });
  });

  it("parses JSON accumulated across stream chunks", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"status":'));
        controller.enqueue(encoder.encode('"ok"}'));
        controller.close();
      },
    });

    await expect(readBoundedJson(new Response(body))).resolves.toEqual({
      status: "ok",
    });
  });

  it("cancels the stream and preserves the oversized-response error", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, { status: 200 });

    let caught: unknown;
    try {
      await readBoundedJson(response);
    } catch (error) {
      caught = error;
    }

    expect(cancelled).toBe(true);
    expect(caught).toBeInstanceOf(RhieRequestError);
    expect(caught).toMatchObject({
      message: "RHIE response exceeded the configured size limit",
      code: "RESPONSE_TOO_LARGE",
      status: 200,
      retryable: false,
    });
  });
});
