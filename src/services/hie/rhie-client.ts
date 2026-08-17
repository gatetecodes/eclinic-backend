import { randomUUID } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { logger } from "@/lib/logger";
import { operationOutcomeSchema } from "./fhir.schemas";
import {
  type EndpointDescriptor,
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
/**
 * Hard upper bound on any endpoint's `maxResponseBytes`. The descriptor field
 * exists so the facility bundle can exceed the 2MB default; this stops it from
 * ever being raised to something that would exhaust memory.
 */
const ENDPOINT_MAX_RESPONSE_BYTES_CEILING = 16 * 1024 * 1024;
const FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 30_000;
/**
 * How long a failure stays relevant. Without this the counter only ever reset
 * on success, so isolated failures hours apart accumulated until the breaker
 * tripped on a service that was mostly healthy.
 */
const FAILURE_WINDOW_MS = 60_000;
const LEADING_SLASH_PATTERN = /^\//;
const SAFE_OUTCOME_CODE_PATTERN = /^[A-Za-z-]{1,40}$/;
const CONTENT_LENGTH_PATTERN = /^\d+$/;
export type HieRequestEnvironment = "TEST" | "PRODUCTION";
type RhieRequestParams = {
  service: RhieService;
  method: RhieMethod;
  path: string;
  tenantEnvironment: HieRequestEnvironment;
  query?: Record<string, string>;
  body?: unknown;
  correlationId?: string;
  /**
   * Caps GET retries for this call. Health probes use 1 so a dead endpoint
   * costs one timeout rather than the full retry budget.
   */
  maxAttempts?: number;
  /** Per-attempt timeout for this call, overriding the global default. */
  timeoutMs?: number;
};

type CircuitState = {
  failures: number;
  openUntil: number;
  lastFailureAt: number;
};

const circuits: Record<RhieService, CircuitState> = {
  CLIENT_REGISTRY: { failures: 0, openUntil: 0, lastFailureAt: 0 },
  SHR: { failures: 0, openUntil: 0, lastFailureAt: 0 },
  CITIZEN: { failures: 0, openUntil: 0, lastFailureAt: 0 },
  FACILITY_REGISTRY: { failures: 0, openUntil: 0, lastFailureAt: 0 },
  PROVIDER_REGISTRY: { failures: 0, openUntil: 0, lastFailureAt: 0 },
};

/**
 * Clears breaker state. Circuit state is module-global and only decays on
 * success or after FAILURE_WINDOW_MS, so tests that exercise failure paths
 * would otherwise leak trips into whichever test ran next.
 */
export function resetCircuitBreakers(): void {
  for (const circuit of Object.values(circuits)) {
    circuit.failures = 0;
    circuit.openUntil = 0;
    circuit.lastFailureAt = 0;
  }
}

const BASE_URL_ENV_KEY: Record<RhieService, string> = {
  CLIENT_REGISTRY: "HIE_CLIENT_REGISTRY_BASE_URL",
  SHR: "HIE_SHR_BASE_URL",
  CITIZEN: "HIE_CITIZEN_BASE_URL",
  // Both registry base URLs are unset by default. `configuredBaseUrl` then
  // raises HIE_NOT_CONFIGURED, which the mapping API reports as
  // NOT_CONFIGURED so the admin console falls back to manual attestation
  // instead of offering a Verify action that cannot work.
  FACILITY_REGISTRY: "HIE_FACILITY_REGISTRY_BASE_URL",
  PROVIDER_REGISTRY: "HIE_PROVIDER_REGISTRY_BASE_URL",
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

function configuredEnvironment(
  key:
    | "HIE_DEPLOYMENT_ENVIRONMENT"
    | "HIE_ENDPOINT_ENVIRONMENT"
    | "HIE_CREDENTIAL_ENVIRONMENT"
): HieRequestEnvironment {
  const value = process.env[key]?.trim();
  if (value !== "TEST" && value !== "PRODUCTION") {
    throw new AppError({
      status: 503,
      code: "HIE_ENVIRONMENT_NOT_CONFIGURED",
      message: `${key} must be TEST or PRODUCTION`,
      exposeMessage: true,
    });
  }
  return value;
}

function assertEnvironmentConsistency(
  tenantEnvironment: HieRequestEnvironment
): void {
  const environments = [
    configuredEnvironment("HIE_DEPLOYMENT_ENVIRONMENT"),
    configuredEnvironment("HIE_ENDPOINT_ENVIRONMENT"),
    configuredEnvironment("HIE_CREDENTIAL_ENVIRONMENT"),
  ];
  if (environments.some((environment) => environment !== tenantEnvironment)) {
    throw new AppError({
      status: 503,
      code: "HIE_ENVIRONMENT_MISMATCH",
      message:
        "Tenant, deployment, endpoint, and credential HIE environments must match",
      exposeMessage: true,
    });
  }
}

function configuredBaseUrl(
  service: RhieService,
  tenantEnvironment: HieRequestEnvironment
): URL {
  const key = BASE_URL_ENV_KEY[service];
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
    tenantEnvironment === "TEST" &&
    process.env.NODE_ENV !== "production" &&
    process.env.HIE_ALLOW_INSECURE_TEST === "true";
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && allowInsecureTest)
  ) {
    throw new AppError({
      status: 503,
      code: "HIE_SECURE_TRANSPORT_REQUIRED",
      message: "HIE requires HTTPS or an approved secure tunnel",
      exposeMessage: true,
    });
  }
  return url;
}

/**
 * Presence check that does not throw.
 *
 * Health reporting and the mapping API need to answer "is this registry
 * configured?" without `configuredBaseUrl`'s 503, and must not duplicate the env
 * key strings to do it.
 */
export function isRhieServiceConfigured(service: RhieService): boolean {
  return Boolean(process.env[BASE_URL_ENV_KEY[service]]?.trim());
}

/**
 * Per-endpoint response cap, clamped so no descriptor can request an
 * out-of-memory read.
 */
function endpointMaxResponseBytes(
  endpoint: EndpointDescriptor | undefined
): number {
  return Math.min(
    endpoint?.maxResponseBytes ?? MAX_RESPONSE_BYTES,
    ENDPOINT_MAX_RESPONSE_BYTES_CEILING
  );
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

function validateContentLength(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES
): void {
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
  if (Number(contentLength) > maxBytes) {
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

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort: the validation error is what the caller must see.
  }
}

export async function readBoundedJson(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES
): Promise<unknown> {
  try {
    validateContentLength(response, maxBytes);
  } catch (error) {
    // Rejecting on the header alone means nothing will ever read this body, and
    // an undrained response holds its connection out of the pool. Release it the
    // same way the oversized-stream path below does, then propagate.
    await cancelResponseBody(response);
    throw error;
  }

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
      if (byteLength > maxBytes) {
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

/**
 * Per-call overrides are clamped to the same bounds as the env-configured
 * defaults, so a caller cannot widen the budget beyond what an operator could.
 */
function resolveTimeoutMs(override: number | undefined): number {
  if (
    override === undefined ||
    !Number.isFinite(override) ||
    override <= 0 ||
    override > MAX_TIMEOUT_MS
  ) {
    return requestTimeoutMs();
  }
  return override;
}

function resolveMaxAttempts(params: RhieRequestParams): number {
  if (params.method !== "GET") {
    return 1;
  }
  const override = params.maxAttempts;
  if (
    override === undefined ||
    !Number.isInteger(override) ||
    override < 1 ||
    override > MAX_GET_MAX_ATTEMPTS
  ) {
    return getMaxAttempts();
  }
  return override;
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
  const url = new URL(
    safePath(params),
    configuredBaseUrl(params.service, params.tenantEnvironment)
  );
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

/**
 * Counts *consecutive* failures. `attempts` is the number of attempts the
 * request actually consumed, so one GET that timed out three times weighs three
 * — a black-holing endpoint trips the breaker in roughly two requests instead
 * of five, which is the difference between ~50s and ~2min of hanging callers.
 */
function recordCircuitFailure(
  circuit: CircuitState,
  requestError: RhieRequestError,
  attempts: number
) {
  if (!requestError.retryable) {
    return;
  }
  const now = Date.now();
  if (now - circuit.lastFailureAt > FAILURE_WINDOW_MS) {
    circuit.failures = 0;
  }
  circuit.lastFailureAt = now;
  circuit.failures += Math.max(attempts, 1);
  if (circuit.failures >= FAILURE_THRESHOLD) {
    circuit.openUntil = now + CIRCUIT_OPEN_MS;
  }
}

/**
 * Media type for a request. Every FHIR operation negotiates
 * `application/fhir+json`; the non-FHIR national operations (currently only
 * `getCitizen`) reject it and need plain JSON.
 */
function requestMediaType(request: RhieRequestParams): string {
  return resolveRhieEndpoint(request)?.mediaType === "json"
    ? "application/json"
    : "application/fhir+json";
}

/** Validates a 2xx body against the pinned contract for its endpoint. */
function validateSuccessBody(params: {
  request: RhieRequestParams;
  data: unknown;
  status: number;
}): { data: unknown; status: number } {
  const endpoint = resolveRhieEndpoint(params.request);
  if (!endpoint) {
    throw new RhieRequestError({
      message: "RHIE endpoint contract could not be resolved",
      code: "HIE_PATH_NOT_ALLOWED",
      status: params.status,
      retryable: false,
    });
  }
  const emptySuccess = params.data === null && endpoint.allowEmptySuccess;
  if (emptySuccess || !endpoint.responseSchema) {
    return { data: params.data, status: params.status };
  }
  const parsed = endpoint.responseSchema.safeParse(params.data);
  if (!parsed.success) {
    throw new RhieRequestError({
      message: "RHIE returned a malformed successful response",
      code: "INVALID_RESPONSE",
      status: params.status,
      retryable: false,
    });
  }
  return { data: parsed.data, status: params.status };
}

/** Maps a non-2xx response onto a redacted, code-bearing request error. */
function failureError(response: Response, data: unknown): RhieRequestError {
  const outcome = operationOutcomeSchema.safeParse(data);
  const issueCode = outcome.success ? outcome.data.issue?.[0]?.code : undefined;
  const safeIssueCode =
    issueCode && SAFE_OUTCOME_CODE_PATTERN.test(issueCode)
      ? `_${issueCode.toUpperCase()}`
      : "";
  return new RhieRequestError({
    message: `RHIE request failed with status ${response.status}`,
    code: `RHIE_HTTP_${response.status}${safeIssueCode}`,
    status: response.status,
    retryable: response.status === 429 || response.status >= 500,
  });
}

async function executeRequest(params: {
  request: RhieRequestParams;
  url: URL;
  correlationId: string;
  signal: AbortSignal;
}): Promise<{ data: unknown; status: number }> {
  const mediaType = requestMediaType(params.request);
  const response = await fetch(params.url, {
    method: params.request.method,
    headers: {
      accept: mediaType,
      authorization: authHeader(),
      "content-type": mediaType,
      "x-correlation-id": params.correlationId,
    },
    body:
      params.request.body === undefined
        ? undefined
        : JSON.stringify(params.request.body),
    signal: params.signal,
  });
  const data = await readBoundedJson(
    response,
    endpointMaxResponseBytes(resolveRhieEndpoint(params.request))
  );
  if (!response.ok) {
    throw failureError(response, data);
  }
  return validateSuccessBody({
    request: params.request,
    data,
    status: response.status,
  });
}

export async function rhieRequest(
  params: RhieRequestParams
): Promise<{ data: unknown; correlationId: string; status: number }> {
  assertEnvironmentConsistency(params.tenantEnvironment);
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
  const maxAttempts = resolveMaxAttempts(params);
  const timeoutMs = resolveTimeoutMs(params.timeoutMs);
  let attempt = 0;

  try {
    while (attempt < maxAttempts) {
      attempt += 1;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
    recordCircuitFailure(circuit, requestError, attempt);
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
