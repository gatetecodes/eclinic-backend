import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  getMaxAttempts,
  RhieRequestError,
  readBoundedJson,
  requestTimeoutMs,
  resetCircuitBreakers,
  rhieRequest,
} from "../rhie-client";
import { resolveRhieEndpoint } from "../rhie-endpoints";

const originalRequestTimeout = process.env.HIE_REQUEST_TIMEOUT_MS;
const originalGetMaxAttempts = process.env.HIE_GET_MAX_ATTEMPTS;
const originalRetryBase = process.env.HIE_GET_RETRY_BASE_MS;
const originalRegistryUrl = process.env.HIE_CLIENT_REGISTRY_BASE_URL;
const originalShrUrl = process.env.HIE_SHR_BASE_URL;
const originalUsername = process.env.HIE_BASIC_AUTH_USERNAME;
const originalPassword = process.env.HIE_BASIC_AUTH_PASSWORD;
const originalDeploymentEnvironment = process.env.HIE_DEPLOYMENT_ENVIRONMENT;
const originalEndpointEnvironment = process.env.HIE_ENDPOINT_ENVIRONMENT;
const originalCredentialEnvironment = process.env.HIE_CREDENTIAL_ENVIRONMENT;
const originalAllowInsecureTest = process.env.HIE_ALLOW_INSECURE_TEST;
const originalFetch = globalThis.fetch;

function configureRequestTest() {
  process.env.HIE_CLIENT_REGISTRY_BASE_URL = "https://rhie.test/";
  process.env.HIE_SHR_BASE_URL = "https://rhie.test/";
  process.env.HIE_BASIC_AUTH_USERNAME = "test-user";
  process.env.HIE_BASIC_AUTH_PASSWORD = "test-password";
  process.env.HIE_DEPLOYMENT_ENVIRONMENT = "TEST";
  process.env.HIE_ENDPOINT_ENVIRONMENT = "TEST";
  process.env.HIE_CREDENTIAL_ENVIRONMENT = "TEST";
  process.env.HIE_GET_RETRY_BASE_MS = "0";
}

afterEach(() => {
  resetCircuitBreakers();
  process.env.HIE_REQUEST_TIMEOUT_MS = originalRequestTimeout;
  process.env.HIE_GET_MAX_ATTEMPTS = originalGetMaxAttempts;
  process.env.HIE_GET_RETRY_BASE_MS = originalRetryBase;
  process.env.HIE_CLIENT_REGISTRY_BASE_URL = originalRegistryUrl;
  process.env.HIE_SHR_BASE_URL = originalShrUrl;
  process.env.HIE_BASIC_AUTH_USERNAME = originalUsername;
  process.env.HIE_BASIC_AUTH_PASSWORD = originalPassword;
  process.env.HIE_DEPLOYMENT_ENVIRONMENT = originalDeploymentEnvironment;
  process.env.HIE_ENDPOINT_ENVIRONMENT = originalEndpointEnvironment;
  process.env.HIE_CREDENTIAL_ENVIRONMENT = originalCredentialEnvironment;
  process.env.HIE_ALLOW_INSECURE_TEST = originalAllowInsecureTest;
  globalThis.fetch = originalFetch;
});

describe("GET retry policy", () => {
  it("bounds invalid attempt configuration", () => {
    process.env.HIE_GET_MAX_ATTEMPTS = "50";
    expect(getMaxAttempts()).toBe(3);
    process.env.HIE_GET_MAX_ATTEMPTS = "1";
    expect(getMaxAttempts()).toBe(1);
  });

  it("retries a transient GET with one correlation id", async () => {
    configureRequestTest();
    process.env.HIE_GET_MAX_ATTEMPTS = "3";
    const correlationIds: string[] = [];
    let calls = 0;
    globalThis.fetch = mock((_input, init) => {
      calls += 1;
      correlationIds.push(
        new Headers(init?.headers).get("x-correlation-id") ?? ""
      );
      return Promise.resolve(
        calls === 1
          ? new Response('{"resourceType":"OperationOutcome"}', { status: 503 })
          : new Response('{"resourceType":"Bundle","type":"searchset"}')
      );
    }) as typeof fetch;

    await expect(
      rhieRequest({
        service: "CLIENT_REGISTRY",
        method: "GET",
        path: "Patient",
        tenantEnvironment: "TEST",
      })
    ).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(2);
    expect(new Set(correlationIds).size).toBe(1);
  });

  it("does not retry POST requests", async () => {
    configureRequestTest();
    const fetchMock = mock(async () => new Response("{}", { status: 503 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      rhieRequest({
        service: "SHR",
        method: "POST",
        path: "Consent",
        tenantEnvironment: "TEST",
        body: {
          resourceType: "Consent",
          status: "active",
          scope: { coding: [{ code: "treatment" }] },
          category: [{}],
          patient: { reference: "Patient/test-patient" },
          dateTime: "2026-08-11T00:00:00.000Z",
        },
      })
    ).rejects.toMatchObject({ status: 503, retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries 429 responses only up to the configured bound", async () => {
    configureRequestTest();
    process.env.HIE_GET_MAX_ATTEMPTS = "2";
    const fetchMock = mock(async () => new Response("{}", { status: 429 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      rhieRequest({
        service: "CLIENT_REGISTRY",
        method: "GET",
        path: "Patient",
        tenantEnvironment: "TEST",
      })
    ).rejects.toMatchObject({ status: 429, retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not expose credentials or OperationOutcome diagnostics", async () => {
    configureRequestTest();
    process.env.HIE_GET_MAX_ATTEMPTS = "1";
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            resourceType: "OperationOutcome",
            issue: [
              {
                severity: "error",
                code: "security",
                diagnostics: "test-password patient-secret",
              },
            ],
          }),
          { status: 401 }
        )
    ) as typeof fetch;

    let caught: unknown;
    try {
      await rhieRequest({
        service: "CLIENT_REGISTRY",
        method: "GET",
        path: "Patient",
        tenantEnvironment: "TEST",
        query: { identifier: "patient-secret" },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RhieRequestError);
    expect(JSON.stringify(caught)).not.toContain("test-password");
    expect(JSON.stringify(caught)).not.toContain("patient-secret");
  });

  it("classifies an aborted request as a retryable timeout", async () => {
    configureRequestTest();
    process.env.HIE_GET_MAX_ATTEMPTS = "1";
    process.env.HIE_REQUEST_TIMEOUT_MS = "1";
    globalThis.fetch = mock(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })
    ) as typeof fetch;

    await expect(
      rhieRequest({
        service: "CLIENT_REGISTRY",
        method: "GET",
        path: "Patient",
        tenantEnvironment: "TEST",
      })
    ).rejects.toMatchObject({ code: "RHIE_TIMEOUT", retryable: true });
  });
});

describe("environment safety boundary", () => {
  it.each([
    "HIE_DEPLOYMENT_ENVIRONMENT",
    "HIE_ENDPOINT_ENVIRONMENT",
    "HIE_CREDENTIAL_ENVIRONMENT",
  ] as const)("rejects a mismatched %s before network I/O", async (key) => {
    configureRequestTest();
    process.env[key] = "PRODUCTION";
    const fetchMock = mock(
      async () => new Response('{"resourceType":"Bundle","type":"searchset"}')
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      rhieRequest({
        service: "CLIENT_REGISTRY",
        method: "GET",
        path: "Patient",
        tenantEnvironment: "TEST",
      })
    ).rejects.toMatchObject({ code: "HIE_ENVIRONMENT_MISMATCH" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("permits approved plain HTTP only for matching test environments", async () => {
    configureRequestTest();
    process.env.HIE_CLIENT_REGISTRY_BASE_URL = "http://rhie.test/";
    process.env.HIE_ALLOW_INSECURE_TEST = "true";
    globalThis.fetch = mock(
      async () => new Response('{"resourceType":"Bundle","type":"searchset"}')
    ) as typeof fetch;

    await expect(
      rhieRequest({
        service: "CLIENT_REGISTRY",
        method: "GET",
        path: "Patient",
        tenantEnvironment: "TEST",
      })
    ).resolves.toMatchObject({ status: 200 });
  });

  it("requires HTTPS for production tenants even with the test override", async () => {
    configureRequestTest();
    process.env.HIE_DEPLOYMENT_ENVIRONMENT = "PRODUCTION";
    process.env.HIE_ENDPOINT_ENVIRONMENT = "PRODUCTION";
    process.env.HIE_CREDENTIAL_ENVIRONMENT = "PRODUCTION";
    process.env.HIE_CLIENT_REGISTRY_BASE_URL = "http://rhie.test/";
    process.env.HIE_ALLOW_INSECURE_TEST = "true";
    const fetchMock = mock(
      async () => new Response('{"resourceType":"Bundle","type":"searchset"}')
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      rhieRequest({
        service: "CLIENT_REGISTRY",
        method: "GET",
        path: "Patient",
        tenantEnvironment: "PRODUCTION",
      })
    ).rejects.toMatchObject({ code: "HIE_SECURE_TRANSPORT_REQUIRED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
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

  it.each([
    [
      "an oversized content-length",
      String(2 * 1024 * 1024 + 1),
      {
        message: "RHIE response exceeded the configured size limit",
        code: "RESPONSE_TOO_LARGE",
        retryable: false,
      },
    ],
    [
      "a malformed content-length",
      "not-a-number",
      {
        message: "RHIE returned an invalid content-length header",
        code: "INVALID_RESPONSE",
        retryable: true,
      },
    ],
  ])(
    "cancels the stream when rejecting %s",
    async (_label, header, expected) => {
      let cancelled = false;
      let read = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          read = true;
          controller.enqueue(new Uint8Array([123, 125]));
          controller.close();
        },
        cancel() {
          cancelled = true;
        },
      });
      // 503 so the retryable flag differs between the two rejection paths.
      const response = new Response(body, {
        status: 503,
        headers: { "content-length": header },
      });

      let caught: unknown;
      try {
        await readBoundedJson(response);
      } catch (error) {
        caught = error;
      }

      expect(cancelled).toBe(true);
      expect(read).toBe(false);
      expect(caught).toBeInstanceOf(RhieRequestError);
      expect(caught).toMatchObject({ ...expected, status: 503 });
    }
  );

  it("still reads a body whose content-length is within the limit", async () => {
    const response = new Response('{"status":"ok"}', {
      status: 200,
      headers: { "content-length": "15" },
    });

    await expect(readBoundedJson(response)).resolves.toEqual({ status: "ok" });
  });
});

describe("typed RHIE endpoint registry", () => {
  it.each([
    "Encounter",
    "AllergyIntolerance",
    "Immunization",
    "Condition",
    "Procedure",
  ])("admits the documented %s list endpoint", (path) => {
    expect(
      resolveRhieEndpoint({ service: "SHR", method: "GET", path })
    ).toBeDefined();
  });

  it.each([
    "Encounter/consultation",
    "Encounter/transfer",
    "Observation/vital-signs",
    "ServiceRequest/lab",
    "ServiceRequest/imaging",
  ])("does not mistake operation path %s for a resource id", (path) => {
    expect(
      resolveRhieEndpoint({ service: "SHR", method: "GET", path })
    ).toBeUndefined();
  });

  it("keeps undocumented Patient creation externally blocked", () => {
    expect(
      resolveRhieEndpoint({
        service: "CLIENT_REGISTRY",
        method: "POST",
        path: "Patient",
      })
    ).toBeUndefined();
  });
});

describe("per-call request budget", () => {
  it("caps retries below the configured default", async () => {
    configureRequestTest();
    process.env.HIE_GET_MAX_ATTEMPTS = "3";
    const fetchMock = mock(async () => new Response("{}", { status: 503 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      rhieRequest({
        service: "CLIENT_REGISTRY",
        method: "GET",
        path: "Patient",
        tenantEnvironment: "TEST",
        maxAttempts: 1,
      })
    ).rejects.toMatchObject({ status: 503 });
    // Health probes rely on this: one attempt, not the full retry budget.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores an out-of-range attempt override", async () => {
    configureRequestTest();
    process.env.HIE_GET_MAX_ATTEMPTS = "2";
    const fetchMock = mock(async () => new Response("{}", { status: 503 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      rhieRequest({
        service: "CLIENT_REGISTRY",
        method: "GET",
        path: "Patient",
        tenantEnvironment: "TEST",
        maxAttempts: 99,
      })
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts on the per-call timeout instead of the global default", async () => {
    configureRequestTest();
    process.env.HIE_REQUEST_TIMEOUT_MS = "30000";
    globalThis.fetch = mock(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        })
    ) as typeof fetch;

    await expect(
      rhieRequest({
        service: "CLIENT_REGISTRY",
        method: "GET",
        path: "Patient",
        tenantEnvironment: "TEST",
        maxAttempts: 1,
        timeoutMs: 20,
      })
    ).rejects.toMatchObject({ code: "RHIE_TIMEOUT" });
  });
});
