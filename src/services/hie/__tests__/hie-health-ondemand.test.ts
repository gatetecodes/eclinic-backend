import { afterEach, describe, expect, it, mock } from "bun:test";

const update = mock(() => Promise.resolve({}));

// health.service reaches the database to persist the probe result. The suite
// runs without DATABASE_URL, and the behaviour under test here is the in-flight
// dedup, not persistence.
mock.module("@/database/db", () => ({
  db: {
    hieTenantConfig: {
      update,
      findMany: mock(() => Promise.resolve([])),
    },
  },
}));

const { refreshTenantHealthOnDemand } = await import("../health.service");
const { resetCircuitBreakers } = await import("../rhie-client");

const CAPABILITY_STATEMENT = JSON.stringify({
  resourceType: "CapabilityStatement",
  status: "active",
});

const originalFetch = globalThis.fetch;

function configureProbeTest() {
  process.env.HIE_CLIENT_REGISTRY_BASE_URL = "https://rhie.test/";
  process.env.HIE_SHR_BASE_URL = "https://rhie.test/";
  process.env.HIE_BASIC_AUTH_USERNAME = "test-user";
  process.env.HIE_BASIC_AUTH_PASSWORD = "test-password";
  process.env.HIE_DEPLOYMENT_ENVIRONMENT = "TEST";
  process.env.HIE_ENDPOINT_ENVIRONMENT = "TEST";
  process.env.HIE_CREDENTIAL_ENVIRONMENT = "TEST";
  process.env.HIE_GET_RETRY_BASE_MS = "0";
}

/** Registry-only tenant, never probed, so the recheck floor does not apply. */
const tenantConfig = {
  clinicId: 1,
  environment: "TEST" as const,
  enabled: true,
  clientRegistryEnabled: true,
  sharedRecordReadEnabled: false,
  sharedRecordWriteEnabled: false,
  transferEnabled: false,
  lastHealthCheckedAt: null,
};

afterEach(() => {
  resetCircuitBreakers();
  update.mockClear();
  globalThis.fetch = originalFetch;
});

describe("on-demand HIE health refresh", () => {
  it("collapses concurrent callers onto a single probe", async () => {
    configureProbeTest();
    // One deferred response both callers would share if dedup works, and would
    // race for if it does not.
    let resolveProbe!: (value: Response) => void;
    const probeResponse = new Promise<Response>((resolve) => {
      resolveProbe = resolve;
    });
    const fetchMock = mock(() => probeResponse);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Both start before either completes — the case the persisted 60s floor
    // cannot catch, because it is only written once a probe finishes.
    const first = refreshTenantHealthOnDemand(tenantConfig);
    const second = refreshTenantHealthOnDemand(tenantConfig);
    resolveProbe(new Response(CAPABILITY_STATEMENT));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(firstResult).toBe(secondResult);
    expect(firstResult).toMatchObject({ clientRegistry: "UP" });
  });

  it("probes again once the previous refresh has settled", async () => {
    configureProbeTest();
    const fetchMock = mock(() =>
      Promise.resolve(new Response(CAPABILITY_STATEMENT))
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await refreshTenantHealthOnDemand(tenantConfig);
    await refreshTenantHealthOnDemand(tenantConfig);

    // The in-flight entry must be cleared on settle, or a tenant would be
    // stuck on one stale result forever.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records an unreachable registry as DOWN rather than throwing", async () => {
    configureProbeTest();
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("{}", { status: 503 }))
    ) as unknown as typeof fetch;

    await expect(
      refreshTenantHealthOnDemand(tenantConfig)
    ).resolves.toMatchObject({ clientRegistry: "DOWN" });
  });
});
