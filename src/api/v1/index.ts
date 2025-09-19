import { Hono } from "hono";
import { auth } from "../../lib/auth";
import { requireAuth } from "../../middlewares/auth";
import activityRouter from "./activity/routes.ts";
import adminRouter from "./admin/routes.ts";
import analyticsRouter from "./analytics/routes.ts";
import appointmentsRouter from "./appointments/appointments.routes.ts";
import approvalsRouter from "./approvals/routes.ts";
import clinicsRouter from "./clinics/clinics.routes.ts";
import filesRouter from "./files/routes.ts";
import inventoryRouter from "./inventory/routes.ts";
import notificationsRouter from "./notifications/routes.ts";
import patientsRouter from "./patients/routes.ts";
import paymentsRouter from "./payments/routes.ts";
// Resource routers
import usersRouter from "./users/routes.ts";
import visitsRouter from "./visits/routes.ts";

const v1 = new Hono();

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

// Global auth for v1 (protect everything else)
v1.use("*", requireAuth);

// Mount resources
v1.route("/users", usersRouter);
v1.route("/patients", patientsRouter);
v1.route("/clinics", clinicsRouter);
v1.route("/visits", visitsRouter);
v1.route("/payments", paymentsRouter);
v1.route("/inventory", inventoryRouter);
v1.route("/analytics", analyticsRouter);
v1.route("/notifications", notificationsRouter);
v1.route("/admin", adminRouter);
v1.route("/files", filesRouter);
v1.route("/activity", activityRouter);
v1.route("/appointments", appointmentsRouter);
v1.route("/approvals", approvalsRouter);

export default v1;
