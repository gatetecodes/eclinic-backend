import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";

const findDemoRequest = mock(() =>
  Promise.resolve<Record<string, unknown> | null>(null)
);
const findUser = mock(() => Promise.resolve<{ id: number } | null>(null));
const provisionClinic = mock(() => Promise.resolve(null));

mock.module(
  new URL("../../../../database/db.ts", import.meta.url).pathname,
  () => ({
    db: {
      demoRequest: { findUnique: findDemoRequest },
      user: { findUnique: findUser },
    },
  })
);
mock.module(
  new URL(
    "../../../../services/clinic-provisioning.service.ts",
    import.meta.url
  ).pathname,
  () => ({ provisionClinic })
);
mock.module(
  new URL("../../../../services/audit.service.ts", import.meta.url).pathname,
  () => ({ writeAudit: mock(() => Promise.resolve()) })
);
mock.module(
  new URL("../../../../services/email.service.ts", import.meta.url).pathname,
  () => ({ sendEmail: mock(() => Promise.resolve()) })
);
mock.module(
  new URL("../../users/users.controller.ts", import.meta.url).pathname,
  () => ({
    createVerificationEmail: mock(() => Promise.resolve({ success: true })),
  })
);

let approveDemoRequest: typeof import("../demo-requests.controller").approveDemoRequest;

const pendingRequest = {
  id: 1,
  status: "PENDING",
  clinicId: null,
  clinic_name: "Kigali Clinic",
  email: "admin@example.com",
  phone_number: "+250788000000",
};

beforeAll(async () => {
  ({ approveDemoRequest } = await import("../demo-requests.controller"));
});

beforeEach(() => {
  findDemoRequest.mockReset();
  findDemoRequest.mockResolvedValue(pendingRequest);
  findUser.mockReset();
  findUser.mockResolvedValue(null);
  provisionClinic.mockClear();
});

const approve = () => {
  const app = new Hono();
  app.post("/:id", approveDemoRequest);
  return app.request("/1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provision: true }),
  });
};

describe("approveDemoRequest conflicts", () => {
  it("rejects an already-approved request", async () => {
    findDemoRequest.mockResolvedValue({
      ...pendingRequest,
      status: "APPROVED",
    });

    const response = await approve();

    expect(response.status).toBe(409);
    expect(findUser).not.toHaveBeenCalled();
    expect(provisionClinic).not.toHaveBeenCalled();
  });

  it("rejects provisioning when the request email already has a user", async () => {
    findUser.mockResolvedValue({ id: 42 });

    const response = await approve();

    expect(response.status).toBe(409);
    expect(findUser).toHaveBeenCalledWith({
      where: { email: pendingRequest.email },
      select: { id: true },
    });
    expect(provisionClinic).not.toHaveBeenCalled();
  });
});
