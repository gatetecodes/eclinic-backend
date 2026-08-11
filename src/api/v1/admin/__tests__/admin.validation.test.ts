import { describe, expect, it } from "bun:test";
import {
  AuditCategory,
  AuditSeverity,
  Role,
  UserStatus,
} from "../../../../../generated/prisma/client";
import {
  adminUsersQuerySchema,
  auditExportQuerySchema,
  auditQuerySchema,
  entitlementUsageQuerySchema,
} from "../admin.validation";

describe("admin cross-tenant query validation", () => {
  it("coerces and bounds entitlement usage pagination", () => {
    expect(
      entitlementUsageQuerySchema.parse({ page: "2", per_page: "50" })
    ).toMatchObject({ page: 2, per_page: 50 });
    expect(
      entitlementUsageQuerySchema.safeParse({ per_page: "101" }).success
    ).toBe(false);
  });

  it("validates user filters against Prisma enums", () => {
    expect(
      adminUsersQuerySchema.parse({
        role: Role.DOCTOR,
        status: UserStatus.ACTIVE,
        clinicId: "7",
      })
    ).toMatchObject({
      page: 1,
      per_page: 20,
      role: Role.DOCTOR,
      status: UserStatus.ACTIVE,
      clinicId: 7,
    });
    expect(adminUsersQuerySchema.safeParse({ role: "OWNER" }).success).toBe(
      false
    );
  });

  it("accepts only allowlisted user sort columns and directions", () => {
    expect(
      adminUsersQuerySchema.parse({ sort: "createdAt.desc" })
    ).toMatchObject({ sort: "createdAt.desc" });
    expect(adminUsersQuerySchema.parse({ sort: "name" })).toMatchObject({
      sort: "name",
    });
    // An empty sort keeps meaning "unset", as it did before the allowlist.
    expect(adminUsersQuerySchema.safeParse({ sort: "" }).success).toBe(true);
    for (const sort of [
      "foo.asc",
      "name.sideways",
      "name.asc.desc",
      "clinic.name",
    ]) {
      expect(adminUsersQuerySchema.safeParse({ sort }).success).toBe(false);
    }
  });

  it("validates paginated audit filters against Prisma enums", () => {
    expect(
      auditQuerySchema.parse({
        category: AuditCategory.SECURITY,
        severity: AuditSeverity.CRITICAL,
        actorId: "3",
      })
    ).toMatchObject({
      page: 1,
      per_page: 20,
      category: AuditCategory.SECURITY,
      severity: AuditSeverity.CRITICAL,
      actorId: 3,
    });
    expect(auditQuerySchema.safeParse({ severity: "LOW" }).success).toBe(false);
  });

  it("validates audit export filters without pagination defaults", () => {
    expect(
      auditExportQuerySchema.parse({
        category: AuditCategory.ACCESS,
        clinicId: "9",
      })
    ).toEqual({ category: AuditCategory.ACCESS, clinicId: 9 });
    expect(
      auditExportQuerySchema.safeParse({ category: "UNKNOWN" }).success
    ).toBe(false);
  });
});
