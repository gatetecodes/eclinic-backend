import { Hono } from "hono";
import { auth } from "../../lib/auth";
import { requireAuth } from "../../middlewares/auth.middleware.ts";
import { entitlementsContext } from "../../middlewares/entitlements.middleware.ts";
import {
  finalizeLocaleContext,
  initializeLocaleContext,
} from "../../middlewares/locale.middleware.ts";
import { tenantContext } from "../../middlewares/tenant.middleware.ts";
import activityRouter from "./activity/routes.ts";
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

v1.use("*", initializeLocaleContext);

v1.route("/demo-requests", demoRequestsRouter);
v1.route("/onboarding", onboardingRouter);
v1.route("/public/queues", publicQueuesRouter);
v1.route("/whatsapp", whatsappRouter);
v1.route("/sms", smsRouter);

// Public auth routes must be mounted BEFORE global auth middleware
// This exposes endpoints like POST /api/v1/auth/login
v1.all("/auth/*", (c) => {
  const request = new Request(c.req.url, {
    method: c.req.method,
    headers: c.req.header(),
    body: c.req.raw.body,
  });
  return auth.handler(request);
});

v1.route("/users", publicUsersRouter);

// Global auth for v1 (protect everything else)
v1.use("*", requireAuth);
v1.use("*", finalizeLocaleContext);

// Mount patient-portal routes BEFORE tenant/entitlements to bypass them while keeping auth
v1.route("/patient-portal", patientPortalRouter);

// Tenant + Entitlements for the rest
v1.use("*", tenantContext);
v1.use("*", entitlementsContext);

// Mount resources
v1.route("/files", fileUploadRouter);
v1.route("/users", usersRouter);
v1.route("/availability", availabilityRouter);
v1.route("/patients", patientsRouter);
v1.route("/clinics", clinicsRouter);
v1.route("/departments", departmentsRouter);
v1.route("/exams", examsRouter);
v1.route("/tariff", tariffRouter);
v1.route("/visits", visitsRouter);
v1.route("/payments", paymentsRouter);
v1.route("/inventory", inventoryRouter);
v1.route("/suppliers", suppliersRouter);
v1.route("/purchase-orders", purchaseOrdersRouter);
v1.route("/analytics", analyticsRouter);
v1.route("/notifications", notificationsRouter);
v1.route("/admin", adminRouter);
v1.route("/activity", activityRouter);
v1.route("/appointments", appointmentsRouter);
v1.route("/approvals", approvalsRouter);
v1.route("/queues", queuesRouter);
v1.route("/insurance-claims", insuranceClaimsRouter);
v1.route("/insurance", insuranceRouter);
v1.route("/hospitalization", hospitalizationRouter);
v1.route("/performance-reports", performanceReportsRouter);
v1.route("/pharmacy", pharmacyRouter);
export default v1;
