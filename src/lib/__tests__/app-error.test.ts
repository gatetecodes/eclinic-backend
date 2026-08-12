import { describe, expect, it } from "bun:test";
import { isUniqueViolationOn } from "../app-error";

function uniqueViolation(target: unknown) {
  return { code: "P2002", meta: { target } };
}

describe("isUniqueViolationOn", () => {
  it("matches exact array target members", () => {
    expect(
      isUniqueViolationOn(
        uniqueViolation(["identifierType", "identifierHash"]),
        ["identifierType", "identifierHash"]
      )
    ).toBe(true);
    expect(
      isUniqueViolationOn(uniqueViolation(["not_idempotencyKey_backup"]), [
        "idempotencyKey",
      ])
    ).toBe(false);
  });

  it("matches only explicit full constraint names", () => {
    expect(
      isUniqueViolationOn(
        uniqueViolation(
          "PatientExternalIdentity_identifierType_identifierHash_key"
        ),
        ["identifierType", "identifierHash"]
      )
    ).toBe(true);
    expect(
      isUniqueViolationOn(
        uniqueViolation("HieOutboxEvent_idempotencyKey_key"),
        ["idempotencyKey"]
      )
    ).toBe(true);
    expect(
      isUniqueViolationOn(
        uniqueViolation("Unrelated_idempotencyKey_archive_key"),
        ["idempotencyKey"]
      )
    ).toBe(false);
  });
});
