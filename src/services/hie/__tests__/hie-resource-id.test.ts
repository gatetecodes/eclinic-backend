import { describe, expect, it } from "bun:test";
import {
  deterministicHieResourceId,
  hieOutboxIdempotencyKey,
} from "../hie-resource-id";

const UUID_V5_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const input = {
  environment: "TEST" as const,
  clinicId: 7,
  localResourceType: "Visit",
  localResourceId: "41",
  hieResourceType: "Encounter",
};

describe("deterministic HIE identities", () => {
  it("returns the same UUID for the same local resource", () => {
    const first = deterministicHieResourceId(input);
    expect(deterministicHieResourceId(input)).toBe(first);
    expect(first).toMatch(UUID_V5_PATTERN);
  });

  it("separates test and production namespaces", () => {
    expect(
      deterministicHieResourceId({ ...input, environment: "PRODUCTION" })
    ).not.toBe(deterministicHieResourceId(input));
  });

  it("builds a stable mutation idempotency key", () => {
    expect(hieOutboxIdempotencyKey({ ...input, operation: "CREATE" })).toBe(
      "TEST:7:Visit:41:Encounter:CREATE"
    );
  });
});
