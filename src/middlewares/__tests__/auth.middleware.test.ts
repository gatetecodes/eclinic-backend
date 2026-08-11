import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { User } from "@/lib/auth";

const findUnique = mock(() =>
  Promise.resolve<{ banned: boolean; role?: string; status: string } | null>({
    banned: false,
    status: "ACTIVE",
  })
);
const getSession = mock(() =>
  Promise.resolve<{
    session: { impersonatedBy?: unknown };
    user: User;
  } | null>(null)
);

mock.module("@/database/db", () => ({
  db: { user: { findUnique } },
}));
mock.module(new URL("../../lib/auth.ts", import.meta.url).pathname, () => ({
  auth: { api: { getSession } },
}));

let requireAuth: typeof import("../auth.middleware").requireAuth;
let getCachedSession: typeof import("@/lib/session-cache").getCachedSession;
let invalidateCachedUser: typeof import("@/lib/session-cache").invalidateCachedUser;
let invalidateUserSessions: typeof import("@/lib/session-cache").invalidateUserSessions;
let setCachedSession: typeof import("@/lib/session-cache").setCachedSession;

const cookie = "session_token=cached-session";
const uncachedCookie = "session_token=uncached-session";
const cachedUser = {
  id: 7,
  role: "DOCTOR",
  status: "ACTIVE",
} as unknown as User;

beforeAll(async () => {
  ({ requireAuth } = await import("../auth.middleware"));
  ({
    getCachedSession,
    invalidateCachedUser,
    invalidateUserSessions,
    setCachedSession,
  } = await import("@/lib/session-cache"));
});

beforeEach(() => {
  invalidateCachedUser(cookie);
  invalidateCachedUser(uncachedCookie);
  findUnique.mockReset();
  findUnique.mockResolvedValue({ banned: false, status: "ACTIVE" });
  getSession.mockReset();
  getSession.mockResolvedValue(null);
});

const requestWithCachedSession = async () => {
  setCachedSession(cookie, { user: cachedUser, impersonatedBy: null });
  const app = new Hono();
  app.use("*", requireAuth);
  app.get("/", (c) => c.text("ok"));
  return app.request("/", { headers: { cookie } });
};

const requestWithoutCachedSession = async () => {
  const app = new Hono();
  app.use("*", requireAuth);
  app.get("/", (c) => c.text("ok"));
  return app.request("/", { headers: { cookie: uncachedCookie } });
};

describe("requireAuth cached sessions", () => {
  it("allows a cache hit only after authoritative access validation", async () => {
    const response = await requestWithCachedSession();

    expect(response.status).toBe(200);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { status: true, banned: true },
    });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("invalidates and rejects a cached user revoked elsewhere", async () => {
    findUnique.mockResolvedValue({ banned: true, status: "INACTIVE" });

    const response = await requestWithCachedSession();

    expect(response.status).toBe(401);
    expect(getCachedSession(cookie, { allowStale: true })).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("rejects impersonation by an identity that is not an active operator", async () => {
    getSession.mockResolvedValue({
      user: cachedUser,
      session: { impersonatedBy: "99" },
    });
    findUnique.mockResolvedValue({
      banned: false,
      role: "DOCTOR",
      status: "ACTIVE",
    });

    const response = await requestWithoutCachedSession();

    expect(response.status).toBe(401);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 99 },
      select: { role: true, status: true, banned: true },
    });
  });

  it("accepts impersonation by an active unbanned SUPER_ADMIN", async () => {
    getSession.mockResolvedValue({
      user: cachedUser,
      session: { impersonatedBy: "99" },
    });
    findUnique.mockResolvedValue({
      banned: false,
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    });

    const response = await requestWithoutCachedSession();

    expect(response.status).toBe(200);
    expect(getCachedSession(uncachedCookie)?.impersonatedBy).toBe(99);
  });
});

describe("impersonated session cache indexing", () => {
  it("invalidates an impersonated session by operator id", () => {
    setCachedSession(cookie, { user: cachedUser, impersonatedBy: 99 });

    invalidateUserSessions(99);

    expect(getCachedSession(cookie, { allowStale: true })).toBeNull();
  });

  it("invalidates an impersonated session by target user id", () => {
    setCachedSession(cookie, { user: cachedUser, impersonatedBy: 99 });

    invalidateUserSessions(cachedUser.id);

    expect(getCachedSession(cookie, { allowStale: true })).toBeNull();
  });
});
