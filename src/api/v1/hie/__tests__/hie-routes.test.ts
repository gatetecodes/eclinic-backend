import { beforeAll, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type {
  AppEnv,
  AppVariables,
} from "../../../../middlewares/auth.middleware";

mock.module("@/database/db", () => ({ db: {} }));
mock.module("@/middlewares/feature.middleware", () => ({
  requireFeature: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));

let app: Hono<AppEnv>;
let adminApp: Hono<AppEnv>;

beforeAll(async () => {
  const { default: hieRouter } = await import("../hie.routes");
  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", {
      id: 1,
      role: "LAB_TECHNICIAN",
    } as unknown as AppVariables["user"]);
    c.set("locale", "en");
    await next();
  });
  app.route("/hie", hieRouter);
  adminApp = new Hono<AppEnv>();
  adminApp.use("*", async (c, next) => {
    c.set("user", {
      id: 2,
      role: "CLINIC_ADMIN",
    } as unknown as AppVariables["user"]);
    c.set("locale", "en");
    await next();
  });
  adminApp.route("/hie", hieRouter);
});

describe("HIE operations boundary validation", () => {
  it.each(["0", "169", "not-a-number"])(
    "rejects invalid metrics window %s",
    async (hours) => {
      const response = await adminApp.request(
        `/hie/operations/summary?hours=${hours}`
      );
      const body = (await response.json()) as { error: { code: string } };

      expect(response.status).toBe(400);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    }
  );
});

describe("HIE mutation route permissions", () => {
  it.each([
    {
      path: "/hie/consents/1/withdraw",
      action: "manageHieConsent",
    },
    {
      path: "/hie/transfers/1/cancel",
      action: "manageHieTransfers",
    },
  ])(
    "requires the dedicated HIE permission for $path",
    async ({ path, action }) => {
      const response = await app.request(path, { method: "POST" });
      const body = (await response.json()) as {
        error: { details: { action: string; resource: string } };
      };

      expect(response.status).toBe(403);
      expect(body.error.details).toEqual({ resource: "hie", action });
    }
  );
});
