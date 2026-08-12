import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { auth } from "../../lib/auth";
import { shouldBlockAuthPath } from "../../lib/auth-path";
import { httpCodes } from "../../lib/constants";
import { requireAuth } from "../../middlewares/auth.middleware.ts";
import { entitlementsContext } from "../../middlewares/entitlements.middleware.ts";
import {
  finalizeLocaleContext,
  initializeLocaleContext,
} from "../../middlewares/locale.middleware.ts";
import { tenantContext } from "../../middlewares/tenant.middleware.ts";
import activityRouter from "./activity/routes.ts";
import impersonationRouter from "./admin/impersonation.routes.ts";
import adminRouter from "./admin/routes.ts";
import analyticsRouter from "./analytics/routes.ts";
import appointmentsRouter from "./appointments/appointments.routes.ts";
import approvalsRouter from "./approvals/routes.ts";
import availabilityRouter from "./availability/availability.routes.ts";
import clinicsRouter from "./clinics/clinics.routes.ts";
import demoRequestsRouter from "./demo-requests/demo-requests.routes.ts";
import departmentsRouter from "./departments/departments.routes.ts";
import examsRouter from "./exams/exams.routes.ts";
import fileUploadRouter from "./files/file-upload.routes.ts";
import hieRouter from "./hie/hie.routes.ts";
import hospitalizationRouter from "./hospitalization/hospitalization.routes.ts";
import insuranceRouter from "./insurance/insurance.routes.ts";
import insuranceClaimsRouter from "./insurance-claim/insurance-claim.routes.ts";
import inventoryRouter from "./inventory/inventory.routes.ts";
import notificationsRouter from "./notifications/routes.ts";
import onboardingRouter from "./onboarding/routes.ts";
import patientPortalRouter from "./patient-portal/patient-portal.routes.ts";
import patientsRouter from "./patients/routes.ts";
import paymentsRouter from "./payments/payments.routes.ts";
import performanceReportsRouter from "./performance-reports/performance-reports.routes.ts";
import pharmacyRouter from "./pharmacy/pharmacy.routes.ts";
import {
  purchaseOrdersRouter,
  suppliersRouter,
} from "./purchasing/purchasing.routes.ts";
import publicQueuesRouter from "./queues/public.routes.ts";
import queuesRouter from "./queues/routes.ts";
import smsRouter from "./sms/sms.routes";
import tariffRouter from "./tariff/tariff.routes.ts";
import publicUsersRouter from "./users/users.public.routes.ts";
// Resource routers
import usersRouter from "./users/users.routes.ts";
import visitsRouter from "./visits/visits.routes.ts";
import whatsappRouter from "./whatsapp/whatsapp.routes";

const v1 = new Hono();

// Mounting through a deliberately schema-erased boundary keeps TypeScript from
// expanding every child router into one enormous aggregate conditional type.
// Each child router remains fully typed and validated in its own module.
const mount = (path: string, childRouter: unknown) => {
  v1.route(path, childRouter as Hono);
};

v1.use("*", initializeLocaleContext);

mount("/demo-requests", demoRequestsRouter);
mount("/onboarding", onboardingRouter);
mount("/public/queues", publicQueuesRouter);
mount("/whatsapp", whatsappRouter);
mount("/sms", smsRouter);

/**
 * The only better-auth admin-plugin routes this app exposes.
 *
 * The plugin is registered solely for impersonation (see src/lib/auth.ts), but it
 * mounts 15 endpoints — including remove-user, set-user-password, set-role and
 * update-user. Those bypass AdminAuditLog entirely, don't keep UserStatus in sync,
 * and remove-user would hard-delete a User that ~40 clinical relations reference.
 * The audited equivalents live in src/api/v1/admin, so everything else is refused
 * here rather than left reachable by anyone holding a SUPER_ADMIN session.
 */
const ADMIN_PLUGIN_ALLOWED_PATHS = new Set([
  "/auth/admin/impersonate-user",
  "/auth/admin/stop-impersonating",
]);

// Public auth routes must be mounted BEFORE global auth middleware
// This exposes endpoints like POST /api/v1/auth/login
v1.all("/auth/*", (c) => {
  if (shouldBlockAuthPath(c.req.path, ADMIN_PLUGIN_ALLOWED_PATHS)) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Not Found" } },
      httpCodes.NOT_FOUND as ContentfulStatusCode
    );
  }

  const request = new Request(c.req.url, {
    method: c.req.method,
    headers: c.req.header(),
    body: c.req.raw.body,
  });
  return auth.handler(request);
});

mount("/users", publicUsersRouter);

// Global auth for v1 (protect everything else)
v1.use("*", requireAuth);
v1.use("*", finalizeLocaleContext);

// Impersonation exit/status: auth-only, before tenant scoping. While impersonating
// the session carries a tenant role, so this must NOT sit behind requireSuperAdmin
// or the operator could never leave the borrowed identity.
mount("/impersonation", impersonationRouter);

// Mount patient-portal routes BEFORE tenant/entitlements to bypass them while keeping auth
mount("/patient-portal", patientPortalRouter);

// Tenant + Entitlements for the rest
v1.use("*", tenantContext);
v1.use("*", entitlementsContext);

// Mount resources
mount("/files", fileUploadRouter);
mount("/users", usersRouter);
mount("/availability", availabilityRouter);
mount("/patients", patientsRouter);
mount("/clinics", clinicsRouter);
mount("/departments", departmentsRouter);
mount("/exams", examsRouter);
mount("/tariff", tariffRouter);
mount("/visits", visitsRouter);
mount("/payments", paymentsRouter);
mount("/inventory", inventoryRouter);
mount("/suppliers", suppliersRouter);
mount("/purchase-orders", purchaseOrdersRouter);
mount("/analytics", analyticsRouter);
mount("/notifications", notificationsRouter);
mount("/admin", adminRouter);
mount("/activity", activityRouter);
mount("/appointments", appointmentsRouter);
mount("/approvals", approvalsRouter);
mount("/queues", queuesRouter);
mount("/insurance-claims", insuranceClaimsRouter);
mount("/insurance", insuranceRouter);
mount("/hospitalization", hospitalizationRouter);
// Keep the large HIE route surface from being re-expanded into the aggregate
// application schema. Runtime routing is unchanged; each HIE route remains
// independently typed and tested at its own boundary.
mount("/hie", hieRouter);
mount("/performance-reports", performanceReportsRouter);
mount("/pharmacy", pharmacyRouter);
export default v1;
