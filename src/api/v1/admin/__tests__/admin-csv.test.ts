import { beforeAll, describe, expect, it, mock } from "bun:test";

mock.module("@/database/db", () => ({ db: {} }));

let csvCell: typeof import("../admin.controller").csvCell;

beforeAll(async () => {
  ({ csvCell } = await import("../admin.controller"));
});

describe("csvCell", () => {
  it.each(["=SUM(A1:A2)", "+cmd", "-1", "@SUM(A1)", "\tformula", "\rformula"])(
    "neutralizes spreadsheet formula prefix %j",
    (value) => {
      expect(csvCell(value)).toBe(`"'${value}"`);
    }
  );

  it("preserves null, date, object, quote, and ordinary value handling", () => {
    const date = new Date("2026-08-09T10:20:30.000Z");

    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(date)).toBe('"2026-08-09T10:20:30.000Z"');
    expect(csvCell({ count: 2 })).toBe('"{""count"":2}"');
    expect(csvCell('safe "quote"')).toBe('"safe ""quote"""');
    expect(csvCell("ordinary")).toBe('"ordinary"');
  });
});
