import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { type Prisma, Role } from "../../../generated/prisma/client";

mock.module("@/database/db", () => ({
  db: { user: { updateMany: mock(() => Promise.resolve({ count: 0 })) } },
}));

const originalDefaultPassword = process.env.DEFAULT_USER_PASSWORD;
const CREDENTIAL_HASH_PATTERN = /^[a-f0-9]{32}:[a-f0-9]{128}$/;

let createStaffAccount: typeof import("../staff-account.service").createStaffAccount;

beforeAll(async () => {
  ({ createStaffAccount } = await import("../staff-account.service"));
});

afterEach(() => {
  if (originalDefaultPassword === undefined) {
    process.env.DEFAULT_USER_PASSWORD = undefined;
  } else {
    process.env.DEFAULT_USER_PASSWORD = originalDefaultPassword;
  }
});

describe("createStaffAccount", () => {
  it("creates a credential without a configured shared default password", async () => {
    process.env.DEFAULT_USER_PASSWORD = undefined;
    const user = {
      id: 42,
      email: "invitee@example.com",
    };
    const createUser = mock(() => Promise.resolve(user));
    const createAccount = mock(() => Promise.resolve({ id: "account-42" }));
    const tx = {
      user: { create: createUser },
      account: { create: createAccount },
    } as unknown as Prisma.TransactionClient;

    await expect(
      createStaffAccount(tx, {
        name: "Invited User",
        email: user.email,
        phone_number: "+250788000000",
        clinicId: 1,
        role: Role.DOCTOR,
      })
    ).resolves.toEqual(user);

    expect(createAccount).toHaveBeenCalledTimes(1);
    const accountData = createAccount.mock.calls[0]?.[0].data;
    expect(accountData).toMatchObject({
      providerId: "credential",
      accountId: "42",
      userId: 42,
    });
    expect(accountData.password).toMatch(CREDENTIAL_HASH_PATTERN);
  });
});
