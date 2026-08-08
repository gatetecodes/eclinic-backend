import { describe, expect, it } from "bun:test";
import { parseDateString } from "../utils";

describe("date-only parsing", () => {
  it("stores ISO and display DOB values at UTC midnight", () => {
    expect(parseDateString("1992-01-01").toISOString()).toBe(
      "1992-01-01T00:00:00.000Z"
    );
    expect(parseDateString("01/01/1992").toISOString()).toBe(
      "1992-01-01T00:00:00.000Z"
    );
  });

  it("rejects impossible calendar dates", () => {
    expect(() => parseDateString("31/02/1992")).toThrow();
  });
});
