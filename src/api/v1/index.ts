import { Hono } from "hono";
import { requireAuth } from "../../middlewares/auth";

// Resource routers
import usersRouter from "./users/routes.ts";
import patientsRouter from "./patients/routes.ts";
import clinicsRouter from "./clinics/routes.ts";
import visitsRouter from "./visits/routes.ts";
import paymentsRouter from "./payments/routes.ts";
import inventoryRouter from "./inventory/routes.ts";
import analyticsRouter from "./analytics/routes.ts";
import notificationsRouter from "./notifications/routes.ts";
import adminRouter from "./admin/routes.ts";
import filesRouter from "./files/routes.ts";
import activityRouter from "./activity/routes.ts";
import appointmentsRouter from "./appointments/routes.ts";
import approvalsRouter from "./approvals/routes.ts";

const v1 = new Hono();

// Global auth for v1
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
