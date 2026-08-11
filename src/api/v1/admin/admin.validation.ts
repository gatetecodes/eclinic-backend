import { z } from "zod";
import {
  AuditCategory,
  AuditSeverity,
  Role,
  UserStatus,
} from "../../../../generated/prisma/client";

const paginationFields = {
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
};

export const entitlementUsageQuerySchema = z.object({
  ...paginationFields,
  featureKey: z.string().trim().max(120).optional(),
  clinicName: z.string().trim().max(120).optional(),
});

/**
 * Columns the operator console may order the user list by. Closed set because
 * `sort` is split into `<column>.<direction>` and handed to Prisma's `orderBy`
 * verbatim — an unlisted column would reach the query builder and fail there as
 * a 500 instead of a validation error.
 */
export const ADMIN_USER_SORT_FIELDS = [
  "id",
  "name",
  "email",
  "role",
  "status",
  "clinicId",
  "createdAt",
  "updatedAt",
] as const;

const SORT_DIRECTIONS = new Set(["asc", "desc"]);
const adminUserSortFields = new Set<string>(ADMIN_USER_SORT_FIELDS);

const adminUserSortSchema = z
  .string()
  .trim()
  .max(120)
  .refine(
    (value) => {
      // `?sort=` is how the table clears its sort — treat it as unset rather
      // than as a rejected value, which is what it meant before this check.
      if (value === "") {
        return true;
      }
      const [column, direction, ...rest] = value.split(".");
      return (
        rest.length === 0 &&
        adminUserSortFields.has(column) &&
        (direction === undefined || SORT_DIRECTIONS.has(direction))
      );
    },
    {
      message: `sort must be "<column>" or "<column>.asc|desc" where column is one of: ${ADMIN_USER_SORT_FIELDS.join(", ")}`,
    }
  );

export const adminUsersQuerySchema = z.object({
  ...paginationFields,
  name: z.string().trim().max(120).optional(),
  sort: adminUserSortSchema.optional(),
  role: z.enum(Role).optional(),
  status: z.enum(UserStatus).optional(),
  clinicId: z.coerce.number().int().positive().optional(),
});

const auditFilterFields = {
  actorId: z.coerce.number().int().positive().optional(),
  action: z.string().trim().max(120).optional(),
  category: z.enum(AuditCategory).optional(),
  severity: z.enum(AuditSeverity).optional(),
  clinicId: z.coerce.number().int().positive().optional(),
};

export const auditQuerySchema = z.object({
  ...paginationFields,
  ...auditFilterFields,
});

export const auditExportQuerySchema = z.object(auditFilterFields);

export type EntitlementUsageQuery = z.infer<typeof entitlementUsageQuerySchema>;
export type AdminUsersQuery = z.infer<typeof adminUsersQuerySchema>;
export type AuditQuery = z.infer<typeof auditQuerySchema>;
export type AuditFilterQuery = z.infer<typeof auditExportQuerySchema>;
