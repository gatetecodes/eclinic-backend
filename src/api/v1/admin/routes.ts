import { Hono } from "hono";
import { z } from "zod";
import { Role, SubscriptionPlan } from "../../../../generated/prisma/client";
import {
  type AppEnv,
  requireSuperAdmin,
} from "../../../middlewares/auth.middleware.ts";
import { validate } from "../../../middlewares/validation.middleware.ts";
import {
  exportAuditLogs,
  getAdminDashboard,
  getAllUsers,
  getAuditLogs,
  getClinicEntitlementOverrides,
  getClinicEntitlements,
  getClinicUsersForAdmin,
  getEntitlementUsageSummary,
  getStats,
  updateClinicLifecycle,
  upsertClinicEntitlementOverrides,
} from "./admin.controller.ts";
import {
  adminUsersQuerySchema,
  auditExportQuerySchema,
  auditQuerySchema,
  entitlementUsageQuerySchema,
} from "./admin.validation.ts";
import {
  inviteUser,
  remindTwoFactor,
  revokeUser,
  updateUserRole,
  updateUserStatus,
} from "./admin-users.controller.ts";
import {
  getClinicSubscription,
  getPlans,
  getSettings,
  getSubscriptions,
  updateClinicPlan,
  updatePlan,
  updateSettings,
} from "./billing.controller.ts";
import {
  createHieClinicalConcept,
  listHieClinicalConcepts,
  updateHieClinicalConcept,
} from "./hie-concepts.controller.ts";
import { startImpersonation } from "./impersonation.controller.ts";
import {
  getClinicClinical,
  getClinicCompliance,
  getPlatformOverview,
} from "./insights.controller.ts";
import {
  listProductTerminology,
  updateProductTerminology,
} from "./terminology.controller.ts";

const router = new Hono<AppEnv>();

const terminologyListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
  status: z.enum(["DRAFT", "VERIFIED"]).optional(),
});

const nullableCode = z
  .string()
  .trim()
  .max(100)
  .nullable()
  .transform((value) => value || null);

const terminologyUpdateSchema = z.object({
  icd11Code: nullableCode,
  loincCode: nullableCode,
  snomedCode: nullableCode,
  ichiCode: nullableCode,
  nationalTariffCode: nullableCode,
  status: z.enum(["DRAFT", "VERIFIED"]),
});

const terminologyProductParamSchema = z.object({
  productId: z.coerce.number().int().positive(),
});

const hieConceptDomainSchema = z.enum([
  "ALLERGY",
  "VACCINE",
  "CONSULTATION_OBSERVATION",
  "IMAGING_PROCEDURE",
  "IMAGING_REASON",
  "BODY_SITE",
  "MEDICATION_ROUTE",
  "ADMINISTRATION_METHOD",
]);
const hieConceptListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
  domain: hieConceptDomainSchema.optional(),
  status: z.enum(["DRAFT", "VERIFIED"]).optional(),
});
const hieConceptInputSchema = z.object({
  domain: hieConceptDomainSchema,
  codingSystem: z.string().trim().min(1).max(300),
  code: z.string().trim().min(1).max(120),
  display: z.string().trim().min(1).max(300),
  status: z.enum(["DRAFT", "VERIFIED"]),
  active: z.boolean(),
});
const hieConceptParamSchema = z.object({
  conceptId: z.coerce.number().int().positive(),
});

// Platform-operator surface: cross-tenant data. Gate the whole module to the
// SaaS operator (previously `requireAdmin`, which also admitted CLINIC_ADMIN
// and leaked global stats/usage to tenant admins).
router.use("*", requireSuperAdmin);
router.get("/dashboard", getAdminDashboard);
router.get("/stats", getStats);
// Network-wide overview backing the /admin home. Supersedes /dashboard, which is
// kept until the old widgets are retired.
router.get("/overview", getPlatformOverview);

const overridesSchema = z.object({
  overrides: z
    .array(
      z.object({
        featureKey: z.string(),
        allowed: z.boolean().optional(),
        limit: z.number().int().min(0).optional(),
        notes: z.string().optional(),
      })
    )
    .min(1),
});

// A reason is mandatory: suspending or archiving a clinic disrupts live clinical
// care, so the audit trail must say why it happened.
const lifecycleSchema = z.object({
  action: z.enum(["suspend", "reactivate", "archive"]),
  reason: z.string().trim().min(1).max(500),
});

router.get(
  "/entitlements/usage/summary",
  validate(entitlementUsageQuerySchema, "query"),
  getEntitlementUsageSummary
);

// Cross-tenant user directory + audit trail.
router.get("/users", validate(adminUsersQuerySchema, "query"), getAllUsers);
router.get("/audit", validate(auditQuerySchema, "query"), getAuditLogs);
router.get(
  "/audit/export",
  validate(auditExportQuerySchema, "query"),
  exportAuditLogs
);

// PATIENT is excluded: a patient-portal account is not staff and must be created
// through the portal signup flow, which links it to a Patient record.
const STAFF_ROLES = Object.values(Role).filter(
  (role) => role !== Role.PATIENT
) as [Role, ...Role[]];

const inviteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email(),
  phone_number: z.string().trim().min(1).max(30),
  clinicId: z.number().int().positive(),
  branchId: z.number().int().positive().optional(),
  role: z.enum(STAFF_ROLES),
});

const roleSchema = z.object({ role: z.enum(STAFF_ROLES) });

const userStatusSchema = z.object({
  action: z.enum(["suspend", "reinstate"]),
  reason: z.string().trim().max(500).optional(),
});

// Staff membership management. Mutations here change what an account can do, so
// each one invalidates that user's cached sessions (see the controller).
router.post("/users/invite", validate(inviteSchema, "json"), inviteUser);
router.put("/users/:id/role", validate(roleSchema, "json"), updateUserRole);
router.put(
  "/users/:id/status",
  validate(userStatusSchema, "json"),
  updateUserStatus
);
router.get(
  "/hie-clinical-concepts",
  validate(hieConceptListSchema, "query"),
  listHieClinicalConcepts
);
router.post(
  "/hie-clinical-concepts",
  validate(hieConceptInputSchema, "json"),
  createHieClinicalConcept
);
router.put(
  "/hie-clinical-concepts/:conceptId",
  validate(hieConceptParamSchema, "param"),
  validate(hieConceptInputSchema, "json"),
  updateHieClinicalConcept
);
router.delete("/users/:id", revokeUser);
router.post("/users/:id/remind-2fa", remindTwoFactor);

// A reason is mandatory: impersonation is the most sensitive action in the console
// and the audit trail is the only record of why an operator viewed patient data as
// somebody else. The matching stop/status routes live outside this operator-gated
// router — see impersonation.routes.ts.
const impersonateSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

router.post(
  "/users/:id/impersonate",
  validate(impersonateSchema, "json"),
  startImpersonation
);

// Plan catalogue + subscription roster. Prices and seat caps live in the Plan
// table; MRR is derived from them, not stored.
const planPatchSchema = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(240).nullable().optional(),
  monthlyPrice: z.number().nonnegative().optional(),
  seatCap: z.number().int().positive().nullable().optional(),
  isActive: z.boolean().optional(),
});

const clinicPlanSchema = z.object({
  plan: z.enum(SubscriptionPlan),
});

const settingsSchema = z.object({
  requireTwoFactor: z.boolean().optional(),
  restrictAdminIps: z.boolean().optional(),
  // Bounded: an unbounded idle timeout would defeat the point of the setting.
  impersonationIdleTimeoutMinutes: z.number().int().min(1).max(120).optional(),
  requireExportReason: z.boolean().optional(),
  // Floor of 7 days so the audit trail cannot be configured away entirely.
  auditRetentionDays: z.number().int().min(7).max(3650).optional(),
});

router.get("/plans", getPlans);
router.put("/plans/:plan", validate(planPatchSchema, "json"), updatePlan);
router.get("/subscriptions", getSubscriptions);

router.get("/settings", getSettings);
router.put("/settings", validate(settingsSchema, "json"), updateSettings);

router.get(
  "/product-terminology",
  validate(terminologyListSchema, "query"),
  listProductTerminology
);
router.put(
  "/product-terminology/:productId",
  validate(terminologyProductParamSchema, "param"),
  validate(terminologyUpdateSchema, "json"),
  updateProductTerminology
);

router.get("/clinics/:id/subscription", getClinicSubscription);
router.put(
  "/clinics/:id/plan",
  validate(clinicPlanSchema, "json"),
  updateClinicPlan
);

router.get("/clinics/:id/entitlements", getClinicEntitlements);

router.get(
  "/clinics/:id/entitlements/overrides",
  getClinicEntitlementOverrides
);

router.put(
  "/clinics/:id/entitlements/overrides",
  validate(overridesSchema, "json"),
  upsertClinicEntitlementOverrides
);

// Tenant management: staff of one clinic + lifecycle transitions.
router.get("/clinics/:id/users", getClinicUsersForAdmin);
router.get("/clinics/:id/clinical", getClinicClinical);
router.get("/clinics/:id/compliance", getClinicCompliance);
router.put(
  "/clinics/:id/status",
  validate(lifecycleSchema, "json"),
  updateClinicLifecycle
);

export default router;
