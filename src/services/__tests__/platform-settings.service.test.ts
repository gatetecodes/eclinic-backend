import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

const settings = {
  id: 1,
  requireTwoFactor: false,
  restrictAdminIps: false,
  impersonationIdleTimeoutMinutes: 15,
  requireExportReason: true,
  auditRetentionDays: 90,
  updatedAt: new Date("2026-08-08T00:00:00.000Z"),
};

const findUnique = mock(() => Promise.resolve<typeof settings | null>(null));
const createMany = mock(() => Promise.resolve({ count: 1 }));
const findUniqueOrThrow = mock(() => Promise.resolve(settings));
const upsert = mock(() => Promise.resolve(settings));

mock.module("@/database/db", () => ({
  db: {
    platformSetting: {
      findUnique,
      createMany,
      findUniqueOrThrow,
      upsert,
    },
  },
}));

let getPlatformSettings: typeof import("../platform-settings.service").getPlatformSettings;
let updatePlatformSettings: typeof import("../platform-settings.service").updatePlatformSettings;

beforeAll(async () => {
  ({ getPlatformSettings, updatePlatformSettings } = await import(
    "../platform-settings.service"
  ));
});

beforeEach(() => {
  findUnique.mockReset();
  findUnique.mockResolvedValue(null);
  createMany.mockReset();
  createMany.mockResolvedValue({ count: 1 });
  findUniqueOrThrow.mockReset();
  findUniqueOrThrow.mockResolvedValue(settings);
  upsert.mockReset();
  upsert.mockResolvedValue(settings);
});

describe("platform settings initialization", () => {
  it("uses a conflict-safe insert before re-reading a missing row", async () => {
    await expect(getPlatformSettings()).resolves.toEqual(settings);
    expect(createMany).toHaveBeenCalledWith({
      data: { id: 1 },
      skipDuplicates: true,
    });
    expect(findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it("routes an empty update through conflict-safe initialization", async () => {
    await expect(updatePlatformSettings({})).resolves.toEqual(settings);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("preserves the normal upsert for a non-empty update", async () => {
    await expect(
      updatePlatformSettings({ requireTwoFactor: true })
    ).resolves.toEqual(settings);
    expect(upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      create: { id: 1, requireTwoFactor: true },
      update: { requireTwoFactor: true },
    });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("propagates unrelated insert errors", async () => {
    const error = new Error("database unavailable");
    createMany.mockRejectedValueOnce(error);

    await expect(getPlatformSettings()).rejects.toBe(error);
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });
});
