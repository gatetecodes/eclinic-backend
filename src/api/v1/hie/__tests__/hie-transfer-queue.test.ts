import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Context } from "hono";
import type { AppEnv } from "@/middlewares/auth.middleware";

process.env.HIE_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

let transferStatus: "DRAFT" | "FAILED" = "DRAFT";
let claimAttempts = 0;
let claimLimit = 1;
let claimArgs: { where?: Record<string, unknown> } | undefined;

const createEvent = mock(() => Promise.resolve({ id: "event-new" }));
const findRetryEvent = mock(() => Promise.resolve({ id: "event-retry" }));
const updateEvent = mock(() => Promise.resolve({ id: "event-retry" }));

const transactionClient = {
  hieExternalTransfer: {
    findFirst: mock(() =>
      Promise.resolve({
        id: 12,
        clinicId: 3,
        patientId: 7,
        status: transferStatus,
      })
    ),
    updateMany: mock((args: { where?: Record<string, unknown> }) => {
      claimArgs = args;
      claimAttempts += 1;
      return Promise.resolve({ count: claimAttempts <= claimLimit ? 1 : 0 });
    }),
  },
  hieOutboxEvent: {
    create: createEvent,
    findFirst: findRetryEvent,
    update: updateEvent,
  },
};

mock.module("@/database/db", () => ({
  db: {
    hieTenantConfig: {
      findUnique: mock(() =>
        Promise.resolve({ enabled: true, transferEnabled: true })
      ),
    },
    $transaction: (
      callback: (tx: typeof transactionClient) => Promise<unknown>
    ) => callback(transactionClient),
    hieAuditEvent: { create: mock(() => Promise.resolve({ id: 1 })) },
  },
}));

mock.module("@/services/hie/outbox.service", () => ({
  resumeBlockedPatientEvents: mock(() => Promise.resolve(0)),
  retryHieEvent: mock(() => Promise.resolve({ count: 0 })),
}));

let queueExternalTransfer: typeof import("../hie.controller").queueExternalTransfer;

beforeAll(async () => {
  ({ queueExternalTransfer } = await import("../hie.controller"));
});

beforeEach(() => {
  transferStatus = "DRAFT";
  claimAttempts = 0;
  claimLimit = 1;
  claimArgs = undefined;
  createEvent.mockClear();
  findRetryEvent.mockClear();
  updateEvent.mockClear();
});

function context(): Context<AppEnv> {
  return {
    get: (key: string) => {
      if (key === "clinicId") {
        return 3;
      }
      if (key === "user") {
        return { id: 5 };
      }
      return key === "locale" ? "en" : undefined;
    },
    req: { param: () => "12" },
    header: () => {
      // Response headers are outside these transaction assertions.
    },
    json: (body: unknown, status?: number) => ({ body, status }),
  } as unknown as Context<AppEnv>;
}

describe("external transfer queue claims", () => {
  it("allows only one caller to claim a draft transfer", async () => {
    const results = await Promise.allSettled([
      queueExternalTransfer(context()),
      queueExternalTransfer(context()),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(claimArgs?.where).toMatchObject({
      id: 12,
      clinicId: 3,
      status: "DRAFT",
    });
  });

  it("revives the retry event selected from the claimed failed status", async () => {
    transferStatus = "FAILED";

    await queueExternalTransfer(context());

    expect(findRetryEvent).toHaveBeenCalledTimes(1);
    expect(updateEvent).toHaveBeenCalledTimes(1);
    expect(createEvent).not.toHaveBeenCalled();
    expect(claimArgs?.where).toMatchObject({ status: "FAILED" });
  });
});
