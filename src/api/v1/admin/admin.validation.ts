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

export const adminUsersQuerySchema = z.object({
  ...paginationFields,
  name: z.string().trim().max(120).optional(),
  sort: z.string().trim().max(120).optional(),
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
