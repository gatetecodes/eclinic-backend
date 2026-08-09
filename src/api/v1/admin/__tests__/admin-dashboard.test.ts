import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Context } from "hono";
import { SubscriptionStatus } from "../../../../../generated/prisma/client";

const usageRows = Array.from({ length: 101 }, (_, index) => ({
  clinicId: index + 1,
  featureKey: "appointments",
  count: 200 - index,
}));

const entitlementUsageFindMany = mock(() => Promise.resolve(usageRows));
const clinicFindMany = mock(() =>
  Promise.resolve<Array<{ id: number; name: string }>>([])
);
const getCachedEntitlements = mock((clinicId: number) =>
  Promise.resolve({ clinicId, limits: { appointments: 1 } })
);

mock.module("@/database/db", () => ({
  db: {
    clinic: {
      groupBy: mock(() =>
        Promise.resolve([
          {
            subscriptionStatus: SubscriptionStatus.ACTIVE,
            _count: { id: 1 },
          },
        ])
      ),
      count: mock(() => Promise.resolve(0)),
      findMany: clinicFindMany,
    },
    user: { count: mock(() => Promise.resolve(0)) },
    payment: {
      aggregate: mock(() => Promise.resolve({ _sum: { amount: 0 } })),
    },
    demoRequest: { findMany: mock(() => Promise.resolve([])) },
    entitlementUsage: { findMany: entitlementUsageFindMany },
  },
}));

mock.module("@/services/entitlements.service", () => ({
  getCachedEntitlements,
  invalidateEntitlements: mock(() => Promise.resolve()),
}));

let getAdminDashboard: typeof import("../admin.controller").getAdminDashboard;

beforeAll(async () => {
  ({ getAdminDashboard } = await import("../admin.controller"));
});

beforeEach(() => {
  entitlementUsageFindMany.mockClear();
  clinicFindMany.mockClear();
  clinicFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce(
    usageRows.slice(0, 100).map((row) => ({
      id: row.clinicId,
      name: `Clinic ${row.clinicId}`,
    }))
  );
  getCachedEntitlements.mockClear();
});

describe("getAdminDashboard quota scan", () => {
  it("bounds the usage scan and reports truncated breach results", async () => {
    const json = mock((body: unknown, status?: number) => ({ body, status }));
    const c = {
      get: mock((key: string) => (key === "locale" ? "en" : undefined)),
      header: mock(() => {
        // Response headers are outside this quota-scan assertion.
      }),
      json,
    } as unknown as Context;

    await getAdminDashboard(c);

    expect(entitlementUsageFindMany).toHaveBeenCalledWith({
      where: { period: expect.any(String) },
      orderBy: { count: "desc" },
      take: 101,
      select: { clinicId: true, featureKey: true, count: true },
    });
    expect(getCachedEntitlements).toHaveBeenCalledTimes(100);

    const response = json.mock.calls[0]?.[0] as {
      data: {
        queues: {
          quotaBreaches: unknown[];
          quotaBreachesTruncated: boolean;
        };
      };
    };
    expect(response.data.queues.quotaBreaches).toHaveLength(20);
    expect(response.data.queues.quotaBreachesTruncated).toBe(true);
  });
});
