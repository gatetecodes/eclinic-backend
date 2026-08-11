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

beforeAll(async () => {
  const { default: hieRouter } = await import("../hie.routes");
  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", { id: 1, role: "DOCTOR" } as unknown as AppVariables["user"]);
    c.set("locale", "en");
    await next();
  });
  app.route("/hie", hieRouter);
});

describe("HIE mutation route permissions", () => {
  it.each(["/hie/consents/1/withdraw", "/hie/transfers/1/cancel"])(
    "requires update rather than create permission for %s",
    async (path) => {
      const response = await app.request(path, { method: "POST" });
      const body = (await response.json()) as {
        error: { details: { action: string; resource: string } };
      };

      expect(response.status).toBe(403);
      expect(body.error.details).toEqual({ resource: "hie", action: "update" });
    }
  );
});
