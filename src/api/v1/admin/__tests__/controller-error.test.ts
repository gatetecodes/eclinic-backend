import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { AppError } from "@/lib/app-error";

const logError = mock(() => {});

mock.module("@/lib/logger", () => ({
  logger: { error: logError },
}));

let throwAdminControllerError: typeof import("../controller-error").throwAdminControllerError;

beforeAll(async () => {
  ({ throwAdminControllerError } = await import("../controller-error"));
});

beforeEach(() => {
  logError.mockClear();
});

describe("throwAdminControllerError", () => {
  it("logs and replaces unknown errors with a non-exposed AppError", () => {
    const cause = new Error("database credentials leaked");

    expect(() =>
      throwAdminControllerError("admin.operation_failed", cause)
    ).toThrow(
      expect.objectContaining({
        code: "INTERNAL_SERVER_ERROR",
        exposeMessage: false,
        status: 500,
      })
    );
    expect(logError).toHaveBeenCalledWith("admin.operation_failed", {
      error: cause,
    });
  });

  it("logs and preserves an existing AppError", () => {
    const cause = new AppError({ status: 409, code: "CONFLICT" });

    expect(() =>
      throwAdminControllerError("admin.operation_failed", cause)
    ).toThrow(cause);
    expect(logError).toHaveBeenCalledWith("admin.operation_failed", {
      error: cause,
    });
  });
});
