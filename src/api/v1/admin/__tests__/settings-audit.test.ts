import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Context } from "hono";
import type { PlatformSettingsPatch } from "@/services/platform-settings.service";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const settings = {
  id: 1,
  requireTwoFactor: false,
  restrictAdminIps: false,
  impersonationIdleTimeoutMinutes: 15,
  requireExportReason: true,
  auditRetentionDays: 90,
  updatedAt: new Date("2026-08-08T00:00:00.000Z"),
};

const writeAudit = mock(() => Promise.resolve());
const updatePlatformSettings = mock(() => Promise.resolve(settings));

mock.module("@/services/audit.service", () => ({ writeAudit }));

mock.module("@/services/platform-settings.service", () => ({
  getPlatformSettings: mock(() => Promise.resolve(settings)),
  isEmptyPlatformSettingsPatch: (patch: PlatformSettingsPatch) =>
    Object.keys(patch).length === 0,
  updatePlatformSettings,
}));

let updateSettings: typeof import("../billing.controller").updateSettings;

beforeAll(async () => {
  ({ updateSettings } = await import("../billing.controller"));
});

beforeEach(() => {
  writeAudit.mockClear();
  updatePlatformSettings.mockClear();
});

function context(patch: PlatformSettingsPatch) {
  const json = mock((body: unknown, status?: number) => ({ body, status }));
  const c = {
    get: (key: string) => {
      if (key === "validatedJson") {
        return patch;
      }
      return key === "locale" ? "en" : undefined;
    },
    header: () => {
      // Response headers are outside these audit assertions.
    },
    json,
  } as unknown as Context;
  return { c, json };
}

describe("platform settings audit", () => {
  it("audits a real settings change with the changed fields", async () => {
    const { c, json } = context({ requireTwoFactor: true });

    await updateSettings(c);

    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit.mock.calls[0]?.[2]).toMatchObject({
      targetType: "platform",
      metadata: { fields: ["requireTwoFactor"] },
    });
    expect(json.mock.calls[0]?.[0]).toMatchObject({ data: settings });
  });

  it("skips the audit event when the patch changes nothing", async () => {
    const { c, json } = context({});

    await updateSettings(c);

    expect(writeAudit).not.toHaveBeenCalled();
    // The settings are still returned, so the response contract is unchanged.
    expect(json.mock.calls[0]?.[0]).toMatchObject({ data: settings });
  });
});
