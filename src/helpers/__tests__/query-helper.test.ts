import { describe, expect, it } from "bun:test";
import { buildQueryOptions } from "../query-helper";

type Row = { createdAt: Date; updatedAt: Date; name: string };

describe("buildQueryOptions sorting", () => {
  it("defaults to the newest-updated ordering", () => {
    expect(buildQueryOptions<Row>({}).orderBy).toEqual({ updatedAt: "desc" });
  });

  it("parses column and direction", () => {
    expect(buildQueryOptions<Row>({ sort: "name.desc" }).orderBy).toEqual({
      name: "desc",
    });
    expect(buildQueryOptions<Row>({ sort: "name" }).orderBy).toEqual({
      name: "asc",
    });
  });

  it("ignores columns outside an explicit allowlist", () => {
    expect(
      buildQueryOptions<Row>(
        { sort: "foo.asc" },
        {},
        { sortableFields: ["name"] }
      ).orderBy
    ).toEqual({ updatedAt: "desc" });
    expect(
      buildQueryOptions<Row>(
        { sort: "name.desc" },
        {},
        { sortableFields: ["name"] }
      ).orderBy
    ).toEqual({ name: "desc" });
  });

  it("keeps passing columns through when no allowlist is configured", () => {
    expect(buildQueryOptions<Row>({ sort: "foo.asc" }).orderBy).toEqual({
      foo: "asc",
    });
  });
});
