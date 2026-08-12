/**
 * How many times a path may change under decoding before it is rejected.
 *
 * Decoding always shrinks the string, so the loop terminates on its own — but on
 * deeply nested input (`%25252561…`) it terminates after O(length) passes over a
 * string that is still O(length), and this runs on every unauthenticated
 * `/auth/*` request. A real path needs at most one pass; four leaves generous
 * headroom, and anything beyond it is rejected (so the caller blocks it).
 */
const MAX_DECODE_PASSES = 5;

export function normalizeAuthPath(path: string): string | null {
  try {
    let decoded = path;
    let stabilized = false;
    for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        stabilized = true;
        break;
      }
      decoded = next;
    }
    if (!stabilized) {
      return null;
    }

    const segments: string[] = [];
    for (const segment of decoded.replaceAll("\\", "/").split("/")) {
      if (!segment || segment === ".") {
        continue;
      }
      if (segment === "..") {
        segments.pop();
        continue;
      }
      segments.push(segment);
    }

    const authIndex = segments.indexOf("auth");
    const authSegments =
      authIndex === -1 ? segments : segments.slice(authIndex);
    return `/${authSegments.join("/")}`;
  } catch {
    return null;
  }
}

export function shouldBlockAuthPath(
  path: string,
  allowedAdminPaths: ReadonlySet<string>
): boolean {
  const authPath = normalizeAuthPath(path);
  if (!authPath) {
    return true;
  }
  const isAdminPath =
    authPath === "/auth/admin" || authPath.startsWith("/auth/admin/");
  return isAdminPath && !allowedAdminPaths.has(authPath);
}
