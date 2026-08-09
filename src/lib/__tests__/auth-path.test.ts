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

  it("rejects malformed percent encoding", () => {
    const path = "/api/v1/auth/%/admin/delete-user";
    expect(normalizeAuthPath(path)).toBeNull();
    expect(shouldBlockAuthPath(path, allowedAdminPaths)).toBe(true);
  });
});
