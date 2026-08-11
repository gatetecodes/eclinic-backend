import { randomUUID } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { logger } from "@/lib/logger";
import { operationOutcomeSchema } from "./fhir.schemas";
import {
  type RhieMethod,
  type RhieService,
  resolveRhieEndpoint,
} from "./rhie-endpoints";

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_GET_MAX_ATTEMPTS = 3;
const MAX_GET_MAX_ATTEMPTS = 4;
const DEFAULT_GET_RETRY_BASE_MS = 250;
const MAX_GET_RETRY_BASE_MS = 5000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 30_000;
const LEADING_SLASH_PATTERN = /^\//;
const SAFE_OUTCOME_CODE_PATTERN = /^[A-Za-z-]{1,40}$/;
const CONTENT_LENGTH_PATTERN = /^\d+$/;
type RhieRequestParams = {
  service: RhieService;
  method: RhieMethod;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  correlationId?: string;
};

type CircuitState = {
  failures: number;
  openUntil: number;
};

const circuits: Record<RhieService, CircuitState> = {
  CLIENT_REGISTRY: { failures: 0, openUntil: 0 },
  SHR: { failures: 0, openUntil: 0 },
};

export class RhieRequestError extends Error {
  readonly status?: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(params: {
    message: string;
    code: string;
    status?: number;
    retryable: boolean;
  }) {
    super(params.message);
    this.name = "RhieRequestError";
    this.status = params.status;
    this.code = params.code;
    this.retryable = params.retryable;
  }
}

function configuredBaseUrl(service: RhieService): URL {
  const key =
    service === "CLIENT_REGISTRY"
      ? "HIE_CLIENT_REGISTRY_BASE_URL"
      : "HIE_SHR_BASE_URL";
  const raw = process.env[key]?.trim();
  if (!raw) {
    throw new AppError({
      status: 503,
      code: "HIE_NOT_CONFIGURED",
      message: `${service} endpoint is not configured`,
      exposeMessage: true,
    });
  }
  const url = new URL(raw.endsWith("/") ? raw : `${raw}/`);
  const allowInsecureTest =
    process.env.NODE_ENV !== "production" &&
    process.env.HIE_ALLOW_INSECURE_TEST === "true";
  if (url.protocol !== "https:" && !allowInsecureTest) {
    throw new AppError({
      status: 503,
      code: "HIE_SECURE_TRANSPORT_REQUIRED",
      message: "HIE requires HTTPS or an approved secure tunnel",
      exposeMessage: true,
    });
  }
  return url;
}

function authHeader(): string {
  const username = process.env.HIE_BASIC_AUTH_USERNAME?.trim();
  const password = process.env.HIE_BASIC_AUTH_PASSWORD;
  if (!(username && password)) {
    throw new AppError({
      status: 503,
      code: "HIE_CREDENTIALS_NOT_CONFIGURED",
      message: "HIE credentials are not configured",
      exposeMessage: true,
    });
  }
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function safePath(params: RhieRequestParams): string {
  const normalized = params.path.replace(LEADING_SLASH_PATTERN, "");
  if (!resolveRhieEndpoint({ ...params, path: normalized })) {
    throw new AppError({
      status: 500,
      code: "HIE_PATH_NOT_ALLOWED",
      message: "HIE request path is not allowlisted",
    });
  }
  return normalized;
}

function responseTooLargeError(response: Response): RhieRequestError {
  return new RhieRequestError({
    message: "RHIE response exceeded the configured size limit",
    code: "RESPONSE_TOO_LARGE",
    status: response.status,
    retryable: false,
  });
}

function validateContentLength(response: Response): void {
  const contentLength = response.headers.get("content-length");
  if (contentLength === null) {
    return;
  }
  if (!CONTENT_LENGTH_PATTERN.test(contentLength)) {
    throw new RhieRequestError({
      message: "RHIE returned an invalid content-length header",
      code: "INVALID_RESPONSE",
      status: response.status,
      retryable: response.status >= 500,
    });
  }
  if (Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw responseTooLargeError(response);
  }
}

async function cancelReader(reader: {
  cancel(reason?: unknown): Promise<void>;
}): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Preserve the RESPONSE_TOO_LARGE contract if cancellation itself fails.
  }
}

export async function readBoundedJson(response: Response): Promise<unknown> {
  validateContentLength(response);

  if (!response.body) {
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    let result = await reader.read();
    while (!result.done) {
      byteLength += result.value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await cancelReader(reader);
        throw responseTooLargeError(response);
      }
      chunks.push(result.value);
      result = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks, byteLength).toString("utf8");
  if (!body) {
    return null;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new RhieRequestError({
      message: "RHIE returned an invalid JSON response",
      code: "INVALID_RESPONSE",
      status: response.status,
      retryable: response.status >= 500,
    });
  }
}

export function requestTimeoutMs(): number {
  const configuredTimeout = Number(process.env.HIE_REQUEST_TIMEOUT_MS);
  if (
    !Number.isFinite(configuredTimeout) ||
    configuredTimeout <= 0 ||
    configuredTimeout > MAX_TIMEOUT_MS
  ) {
    return DEFAULT_TIMEOUT_MS;
  }
  return configuredTimeout;
}

export function getMaxAttempts(): number {
  const configured = Number(process.env.HIE_GET_MAX_ATTEMPTS);
  if (
    !Number.isInteger(configured) ||
    configured < 1 ||
    configured > MAX_GET_MAX_ATTEMPTS
  ) {
    return DEFAULT_GET_MAX_ATTEMPTS;
  }
  return configured;
}

function getRetryBaseMs(): number {
  const configured = Number(process.env.HIE_GET_RETRY_BASE_MS);
  if (
    !Number.isFinite(configured) ||
    configured < 0 ||
    configured > MAX_GET_RETRY_BASE_MS
  ) {
    return DEFAULT_GET_RETRY_BASE_MS;
  }
  return configured;
}

function waitForRetry(attempt: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, getRetryBaseMs() * 2 ** (attempt - 1));
  });
}

function requestUrl(params: RhieRequestParams): URL {
  const url = new URL(safePath(params), configuredBaseUrl(params.service));
  for (const [key, value] of Object.entries(params.query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url;
}

function normalizeRequestError(error: unknown): RhieRequestError {
  if (error instanceof RhieRequestError) {
    return error;
  }
  const timedOut = error instanceof Error && error.name === "AbortError";
  return new RhieRequestError({
    message: timedOut ? "RHIE request timed out" : "RHIE request failed",
    code: timedOut ? "RHIE_TIMEOUT" : "RHIE_NETWORK_ERROR",
    retryable: true,
  });
}

function recordCircuitFailure(
  circuit: CircuitState,
  requestError: RhieRequestError
) {
  if (!requestError.retryable) {
    return;
  }
  circuit.failures += 1;
  if (circuit.failures >= FAILURE_THRESHOLD) {
    circuit.openUntil = Date.now() + CIRCUIT_OPEN_MS;
  }
}

async function executeRequest(params: {
  request: RhieRequestParams;
  url: URL;
  correlationId: string;
  signal: AbortSignal;
}): Promise<{ data: unknown; status: number }> {
  const response = await fetch(params.url, {
    method: params.request.method,
    headers: {
      accept: "application/fhir+json",
      authorization: authHeader(),
      "content-type": "application/fhir+json",
      "x-correlation-id": params.correlationId,
    },
    body:
      params.request.body === undefined
        ? undefined
        : JSON.stringify(params.request.body),
    signal: params.signal,
  });
  const data = await readBoundedJson(response);
  if (response.ok) {
    const endpoint = resolveRhieEndpoint(params.request);
    if (!endpoint) {
      throw new RhieRequestError({
        message: "RHIE endpoint contract could not be resolved",
        code: "HIE_PATH_NOT_ALLOWED",
        status: response.status,
        retryable: false,
      });
    }
    const emptySuccess = data === null && endpoint.allowEmptySuccess;
    if (!emptySuccess && endpoint.responseSchema) {
      const parsed = endpoint.responseSchema.safeParse(data);
      if (!parsed.success) {
        throw new RhieRequestError({
          message: "RHIE returned a malformed successful response",
          code: "INVALID_RESPONSE",
          status: response.status,
          retryable: false,
        });
      }
      return { data: parsed.data, status: response.status };
    }
    return { data, status: response.status };
  }
  const outcome = operationOutcomeSchema.safeParse(data);
  const issueCode = outcome.success ? outcome.data.issue?.[0]?.code : undefined;
  const safeIssueCode =
    issueCode && SAFE_OUTCOME_CODE_PATTERN.test(issueCode)
      ? `_${issueCode.toUpperCase()}`
      : "";
  throw new RhieRequestError({
    message: `RHIE request failed with status ${response.status}`,
    code: `RHIE_HTTP_${response.status}${safeIssueCode}`,
    status: response.status,
    retryable: response.status === 429 || response.status >= 500,
  });
}

export async function rhieRequest(
  params: RhieRequestParams
): Promise<{ data: unknown; correlationId: string; status: number }> {
  const circuit = circuits[params.service];
  const endpoint = resolveRhieEndpoint({
    service: params.service,
    method: params.method,
    path: params.path.replace(LEADING_SLASH_PATTERN, ""),
  });
  if (!endpoint) {
    throw new AppError({
      status: 500,
      code: "HIE_PATH_NOT_ALLOWED",
      message: "HIE request path is not allowlisted",
    });
  }
  if (
    endpoint.requestSchema &&
    !endpoint.requestSchema.safeParse(params.body).success
  ) {
    throw new AppError({
      status: 500,
      code: "HIE_REQUEST_CONTRACT_INVALID",
      message: "HIE request does not match the pinned contract",
    });
  }
  if (circuit.openUntil > Date.now()) {
    throw new RhieRequestError({
      message: "RHIE service is temporarily unavailable",
      code: "CIRCUIT_OPEN",
      retryable: true,
    });
  }

  const url = requestUrl(params);
  const correlationId = params.correlationId ?? randomUUID();
  const startedAt = Date.now();
  const maxAttempts = params.method === "GET" ? getMaxAttempts() : 1;
  let attempt = 0;

  try {
    while (attempt < maxAttempts) {
      attempt += 1;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs());
      try {
        const response = await executeRequest({
          request: params,
          url,
          correlationId,
          signal: controller.signal,
        });
        circuit.failures = 0;
        circuit.openUntil = 0;
        logger.info("hie.request.completed", {
          service: params.service,
          method: params.method,
          resource: params.path.split("/")[0],
          status: response.status,
          attempts: attempt,
          durationMs: Date.now() - startedAt,
          correlationId,
        });
        return { data: response.data, correlationId, status: response.status };
      } catch (error) {
        const requestError = normalizeRequestError(error);
        if (!(requestError.retryable && attempt < maxAttempts)) {
          throw requestError;
        }
        await waitForRetry(attempt);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new RhieRequestError({
      message: "RHIE request failed",
      code: "RHIE_NETWORK_ERROR",
      retryable: true,
    });
  } catch (error) {
    const requestError = normalizeRequestError(error);
    recordCircuitFailure(circuit, requestError);
    logger.warn("hie.request.failed", {
      service: params.service,
      method: params.method,
      resource: params.path.split("/")[0],
      status: requestError.status,
      code: requestError.code,
      attempts: attempt,
      durationMs: Date.now() - startedAt,
      correlationId,
    });
    throw requestError;
  }
}
