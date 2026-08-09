export function normalizeAuthPath(path: string): string | null {
  try {
    let decoded = path;
    let next = decodeURIComponent(decoded);
    while (next !== decoded) {
      decoded = next;
      next = decodeURIComponent(decoded);
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
