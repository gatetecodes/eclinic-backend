import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { User } from "@/lib/auth";
import type { AppEnv } from "@/middlewares/auth.middleware";

const provisionClinic = mock(() =>
  Promise.resolve({
    newClinic: { id: 10, name: "Kigali Clinic" },
    branch: { id: 20 },
    adminUser: { id: 30, email: "admin@example.com" },
  })
);
const createVerificationEmail = mock(() => Promise.resolve({ success: true }));
const writeAudit = mock(() => Promise.resolve());

mock.module(
  new URL("../../../../database/db.ts", import.meta.url).pathname,
  () => ({ db: {} })
);
mock.module(
  new URL(
    "../../../../services/clinic-provisioning.service.ts",
    import.meta.url
  ).pathname,
  () => ({ provisionClinic })
);
mock.module(
  new URL("../../../../services/entitlements.service.ts", import.meta.url)
    .pathname,
  () => ({ invalidateEntitlements: mock(() => Promise.resolve()) })
);
mock.module(
  new URL("../../../../services/audit.service.ts", import.meta.url).pathname,
  () => ({ writeAudit })
);
mock.module(
  new URL("../../users/users.controller.ts", import.meta.url).pathname,
  () => ({ createVerificationEmail })
);

let createClinic: typeof import("../clinics.controller").createClinic;

beforeAll(async () => {
  ({ createClinic } = await import("../clinics.controller"));
});

beforeEach(() => {
  provisionClinic.mockClear();
  createVerificationEmail.mockClear();
  writeAudit.mockClear();
});

describe("createClinic", () => {
  it("delegates tenant and invited-admin creation to provisionClinic", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { id: 1, role: "SUPER_ADMIN" } as User);
      c.set("locale", "en");
      await next();
    });
    app.post("/", createClinic);

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Kigali Clinic",
        logo: "logo.png",
        operatingCountry: "rw",
        defaultCurrency: "USD",
        subscriptionPlan: "CLINIC_STARTER",
        contactPhone: "+250788000000",
        contactEmail: "clinic@example.com",
        expiryDate: "2026-12-31T00:00:00.000Z",
        admin: {
          name: "Clinic Admin",
          email: "admin@example.com",
          phone_number: "+250788000001",
        },
      }),
    });

    expect(response.status).toBe(201);
    expect(provisionClinic).toHaveBeenCalledWith({
      name: "Kigali Clinic",
      logo: "logo.png",
      operatingCountry: "rw",
      defaultCurrency: "USD",
      subscriptionPlan: "CLINIC_STARTER",
      contactPhone: "+250788000000",
      contactEmail: "clinic@example.com",
      subscriptionExpiryDate: "2026-12-31T00:00:00.000Z",
      admin: {
        name: "Clinic Admin",
        email: "admin@example.com",
        phone_number: "+250788000001",
      },
    });
    expect(createVerificationEmail).toHaveBeenCalledWith("admin@example.com", {
      locale: "en",
    });
  });
});
