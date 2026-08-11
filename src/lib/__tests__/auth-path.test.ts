import { describe, expect, it } from "bun:test";
import { normalizeAuthPath, shouldBlockAuthPath } from "@/lib/auth-path";

const allowedAdminPaths = new Set([
  "/auth/admin/impersonate-user",
  "/auth/admin/stop-impersonating",
]);

describe("normalizeAuthPath", () => {
  it.each([
    "/api/v1/auth//admin/delete-user",
    "/api/v1/auth/%61dmin/delete-user",
    "/api/v1/auth/%2561dmin/delete-user",
    "/api/v1/auth/unused/../admin/delete-user",
    "/api/v1/auth/admin%2Fdelete-user",
  ])("canonicalizes an obfuscated admin path: %s", (path) => {
    expect(normalizeAuthPath(path)).toBe("/auth/admin/delete-user");
    expect(shouldBlockAuthPath(path, allowedAdminPaths)).toBe(true);
  });

  it("preserves an allowed admin endpoint after canonicalization", () => {
    const path = "/api/auth//admin/impersonate-user";
    expect(normalizeAuthPath(path)).toBe("/auth/admin/impersonate-user");
    expect(shouldBlockAuthPath(path, allowedAdminPaths)).toBe(false);
  });

  // Each extra "25" is one more layer of encoding over "%61dmin", so decoding
  // peels exactly one layer per pass.
  const nestedAdmin = (layers: number) => `%${"25".repeat(layers - 1)}61dmin`;

  it("still canonicalizes the deepest nesting the cap allows", () => {
    const path = `/api/v1/auth/${nestedAdmin(4)}/delete-user`;
    expect(normalizeAuthPath(path)).toBe("/auth/admin/delete-user");
    expect(shouldBlockAuthPath(path, allowedAdminPaths)).toBe(true);
  });

  it("rejects a path that keeps decoding past the cap", () => {
    const path = `/api/v1/auth/${nestedAdmin(13)}/delete-user`;
    expect(normalizeAuthPath(path)).toBeNull();
    expect(shouldBlockAuthPath(path, allowedAdminPaths)).toBe(true);
  });

  it("rejects malformed percent encoding", () => {
    const path = "/api/v1/auth/%/admin/delete-user";
    expect(normalizeAuthPath(path)).toBeNull();
    expect(shouldBlockAuthPath(path, allowedAdminPaths)).toBe(true);
  });
});
