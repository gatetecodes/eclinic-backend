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

  it.each([
    ["2000-02-29", "2000-02-29T00:00:00.000Z"],
    ["29/02/2000", "2000-02-29T00:00:00.000Z"],
    ["2025-12-31", "2025-12-31T00:00:00.000Z"],
    ["01/01/2026", "2026-01-01T00:00:00.000Z"],
  ])("preserves date-only boundary fixture %s", (input, expected) => {
    expect(parseDateString(input).toISOString()).toBe(expected);
  });

  it("does not reinterpret an already-correct database DATE value", () => {
    const storedDate = new Date("1992-01-01T00:00:00.000Z");
    expect(parseDateString(storedDate.toISOString().slice(0, 10))).toEqual(
      storedDate
    );
  });
});
