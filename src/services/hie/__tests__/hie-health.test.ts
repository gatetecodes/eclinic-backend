import { describe, expect, it } from "bun:test";
import { readCapabilityHealth } from "../health.schemas";

describe("HIE capability health reads", () => {
  it("returns null when the tenant has never been probed", () => {
    expect(
      readCapabilityHealth({
        capabilityHealth: null,
        lastHealthCheckedAt: null,
      })
    ).toBeNull();
  });

  it("reads a stored per-capability record", () => {
    const checkedAt = "2026-08-16T10:00:00.000Z";
    expect(
      readCapabilityHealth({
        capabilityHealth: {
          clientRegistry: "DOWN",
          sharedRecord: "UP",
          checkedAt,
        },
        lastHealthCheckedAt: new Date(checkedAt),
      })
    ).toEqual({
      clientRegistry: "DOWN",
      sharedRecord: "UP",
      checkedAt,
    });
  });

  it("degrades malformed health to UNKNOWN rather than throwing", () => {
    // UNKNOWN is deliberately not DOWN: an unreadable record must not gate the
    // reception national lookup off a working registry.
    const health = readCapabilityHealth({
      capabilityHealth: { clientRegistry: "BROKEN" },
      lastHealthCheckedAt: null,
    });
    expect(health).toMatchObject({
      clientRegistry: "UNKNOWN",
      sharedRecord: "UNKNOWN",
    });
  });
});
