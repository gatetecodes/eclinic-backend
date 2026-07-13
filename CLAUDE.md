# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**CareLogic Backend** is the API for a multi-tenant clinic / hospital management system (EMR + practice management). It runs on **Bun + Hono.js + Better-Auth + Prisma 7**. It is **not** an Express/Fastify app — there is no BaseController/BaseService/BaseRepository stack, no Swagger, no Joi/celebrate. Requests flow through Hono routers with middleware for auth, tenant scoping, entitlements, and RBAC.

## Commands

```bash
# Development
bun run dev               # Dev server with hot reload (bun run --hot src/index.ts)
bun run build             # Bundle to ./dist (prebuild runs `prisma generate`)
bun run start             # Run built output (dist/index.js)

# Code quality
bun run lint              # ESLint over src (note: no eslint config file present — lint effectively runs via Biome/Ultracite)
bun run format            # Prettier write over src
bun run typecheck         # tsc --noEmit (source, tsconfig.json)
bun run typecheck:test    # tsc --noEmit for tests (tsconfig.test.json)

# Database (Prisma 7)
bun run db:generate       # prisma generate → generated/prisma/
bun run db:push           # prisma db push (no migration)
bun run db:migrate        # prisma migrate dev (create + apply)
bun run db:seed           # prisma db seed (prisma/seed.ts)

# Testing
bun test                  # Run tests
```

**Dev port:** `4002` by default (`src/index.ts`, overridable via `PORT`). Note: `.env.example` / `Dockerfile EXPOSE` say `3001` — the code default is the source of truth.

**Pre-commit:** Husky v9 (`.husky/pre-commit`) stashes unstaged changes and runs **`bun x ultracite fix`** (Biome preset) on staged files, then re-stages. `lint-staged` is declared in two conflicting places (`package.json` and `.lintstagedrc.json`), but the hook itself only invokes `ultracite fix`. The typecheck line in the hook is commented out.

## Architecture

### Entry point
- `src/index.ts` — the only entry. Creates `new Hono<AppEnv>()`, wires global middleware (`logger`, CORS with `credentials:true` and origins from `APP_URL` + `NEXT_UP_URL`, `hono-rate-limiter` at 500 req / 5-min), exposes `GET /health`, mounts `app.route("/api", mainRoutes)`, starts cron via `startRecurringJobs()` (skipped when `NODE_ENV=test`), and installs the global `app.onError` / `app.notFound` handlers.
- **Server transport:** a custom Node `http.createServer` adapter converts Node req/res to Web `Request`/`Response` and calls `app.fetch` (not `Bun.serve`). Socket.io is attached to that server via `initSocket(server)`.

### Request lifecycle
```
src/index.ts (/api)
  → src/routes/index.ts            (mounts v1 at BOTH /v1 and /)
  → src/api/v1/index.ts            (composition root; middleware order matters)
  → <module> router → controller → Prisma singleton `db` (or a src/services helper)
```
Middleware order in `src/api/v1/index.ts`:
1. `initializeLocaleContext` (all v1)
2. **Public routers first** (no auth): `/demo-requests`, `/onboarding`, `/public/queues`, `/whatsapp`, `/sms`
3. **Better-Auth catch-all:** `v1.all("/auth/*", …)` → `auth.handler` (login/session live at `/api/v1/auth/*`)
4. Public `/users` router
5. `requireAuth` → `finalizeLocaleContext` (everything below is authenticated)
6. `/patient-portal` (auth only, no clinic scoping)
7. `tenantContext` → `entitlementsContext`
8. All tenant-scoped resource routers

Because v1 is mounted at both `/v1` and `/`, endpoints are reachable at `/api/v1/...` **and** `/api/...`.

### Module layout (`src/api/v1/<module>/`)
File naming is **mixed** — some modules use `<module>.routes.ts` / `<module>.controller.ts` / `<module>.validation.ts`, others use a bare `routes.ts` (e.g. `patients`, `admin`, `analytics`, `approvals`, `activity`, `notifications`, `onboarding`, `queues`). There is generally **no per-module `*.service.ts` or `*.repository.ts`** — controllers call the shared Prisma singleton `db` directly or reuse global helpers in `src/services/` and `src/helpers/`. There are **no `*.repository.ts` files anywhere**.

Modules present: `activity`, `admin`, `analytics`, `appointments`, `approvals`, `availability`, `clinics`, `demo-requests`, `departments`, `exams`, `files`, `hospitalization`, `insurance`, `insurance-claim`, `inventory`, `notifications`, `onboarding`, `patient-portal`, `patients`, `payments`, `performance-reports`, `pharmacy`, `purchasing`, `queues`, `sms`, `tariff`, `users`, `visits`, `whatsapp`.

The **hospitalization** module is the richest reference (also carries `ews.ts` — a pure NEWS2-style `computeEws(vitals)` early-warning score — and `helpers.ts`). Every mutating route uses `validate(schema, …)` + `crudAccess("visits", "hospitalization")`.

### Shared helpers (no base classes)
There is **no** BaseController/BaseService/BaseRepository inheritance. Shared behavior lives in `src/lib/` and `src/helpers/`:
- **Response shaping** — `src/lib/api-response.ts`: `jsonSuccess(c, {status?, message?, messageKey?, data?, meta?})` and `jsonError(c, {status, code, messageKey?, issues?, details?})`. Both set `Content-Language` and use the i18n translator on context. **Not used uniformly** — many older controllers (e.g. patients) still return raw `c.json(...)`, so envelopes are not universal. Prefer these helpers in new/edited code.
- **Pagination / filtering** — `src/helpers/query-helper.ts`: `buildQueryOptions(params, additionalWhere, config)` → `{ skip, take, orderBy, where }` from `page`/`per_page`/`sort` (`"column.asc|desc"`, default `updatedAt desc`) plus many filter builders (name, patient name, status, careStage, role, gender, doctorId incl. handoffs, clinicId, branchId, itemName/type, insuranceCompany, processedById).
- **Tenant scoping** — `src/lib/request-scope.ts` (`getScope(user, query)`) and `src/lib/scope-where.ts` (`withScope(where, scope, mapping)`, injects `clinicId`/`branchId` into a Prisma where, supports nested paths like `patient.clinicId`).

### Auth & permissions
- **Auth engine:** Better-Auth (`src/lib/auth.ts`) over `prismaAdapter`, `basePath:"/auth"`, email+password with `requireEmailVerification`, **session cookie** `session_token` (7-day expiry, cross-subdomain under `.usecarelogic.com` in prod). Because user IDs are `Int` (not string), a `createCoercingPrisma` proxy coerces id types for Better-Auth. Better-Auth models: `Account`, `Session`, `Verification`.
- **Session middleware:** `requireAuth` (`src/middlewares/auth.middleware.ts`) resolves the session via `auth.api.getSession()`, normalizes numeric ids, and sets `c.set("user", …)`; backed by an in-memory session cache (`src/lib/session-cache.ts`) with in-flight de-dup and stale-fallback. `requireAdmin` restricts to `SUPER_ADMIN`/`CLINIC_ADMIN`.
- **Multi-tenancy:** `tenantContext` (`src/middlewares/tenant.middleware.ts`) derives `clinicId`/`branchId` from the user. `SUPER_ADMIN` may operate without a clinic; others without one get `TENANT_NOT_FOUND` (403). Enforce scoping via `getScope`/`withScope` or explicit `where: { clinicId }`.
- **Per-request context vars** (`AppVariables`): `user`, `clinicId`, `branchId`, `entitlements`, `locale`, `localeSource`, `t` (translator), plus `validatedJson`/`validatedQuery`/`validatedParam`.
- **Permissions:** custom role-based matrix in `src/lib/permissions.ts` (`ROLE_PERMISSIONS`, `hasPermission(user, resource, action)`; `SUPER_ADMIN` always true). **No external permissions package.** `Role` enum (`prisma/schema/user.prisma`): SUPER_ADMIN, CLINIC_ADMIN, BRANCH_ADMIN, DOCTOR, NURSE, LAB_TECHNICIAN, RECEPTIONIST, PHARMACIST, CASHIER, MARKETING, FLOW_MANAGER, STOCK_MANAGER, PATIENT.
- **Enforcement middleware:** `crudAccess(resource, feature?)` (the common gate — maps HTTP method → action, checks feature entitlement then RBAC), `requirePermission({resource, action})` (explicit), plus `entitlements`, `feature`, `quota`, `with-access`, `recaptcha`, `locale` middlewares. `SUPER_ADMIN` bypasses.
- **Entitlements/quotas:** plan-based `FEATURE_MATRIX` in `src/lib/entitlements-matrix.ts` (`CLINIC_STARTER` / `MEDICAL_PLUS` / `HOSPITAL_SUITE`) with per-clinic `EntitlementOverride` / `EntitlementUsage`; services in `src/services/entitlements.service.ts` and `quotas.service.ts`.

### Error handling
- **`AppError`** (`src/lib/app-error.ts`): `{status, code, message?, issues?, exposeMessage?, messageKey?, messageValues?}` + `.toResponse(c)`. Helpers: `notFoundError`, `unauthorizedError`, `forbiddenError`, `fromZodError`, `tryMapPrismaError` (Prisma `P2002` → 409 `UNIQUE_CONSTRAINT_VIOLATION`).
- `src/lib/errors.ts`: `unauthorized(c)`, `forbidden(c, reason, extra)` with reasons `RBAC_DENIED | FEATURE_DISABLED | TENANT_NOT_FOUND | QUOTA_EXCEEDED` (each mapped to an i18n key).
- **Validation:** **Zod v4** via `validate(schema, target)` (`src/middlewares/validation.middleware.ts`) parsing `json`/`query`/`param` into `validated<Target>` context vars. On `ZodError` it returns a `400` `VALIDATION_ERROR` envelope (`error.issues: [{field, code, message}]`, localized).
- The global `app.onError` handles `AppError`, `ZodError`, Prisma errors, else logs with a generated `errorId` and returns 500. Note: some controllers still `try/catch` and return their own ad-hoc `{error}` JSON, so error shape is not perfectly uniform.

### Database
- **Prisma 7.1.0** with the **driver-adapter** setup: `PrismaPg` over a `pg` `Pool` (`src/database/db.ts`). Generated client output is **`generated/prisma/`** (custom output, gitignored) and is imported by **relative path** (`../../generated/prisma/client`), **not** `@prisma/client`.
- **Singleton:** `src/database/db.ts` exports `db` (cached on `globalThis.prisma` in dev; tx `maxWait/timeout = 10s`). It installs a Prisma `$extends` query hook that auto-syncs `Visit.careStage` from `Visit.status` (`careStageForStatus` in `src/lib/care-stage.ts`).
- **Split schema:** many `.prisma` files under `prisma/schema/` (assembled via `prisma.config.ts`, `schema: "./prisma/schema"`), one per domain — `schema.prisma` (generator/datasource + Better-Auth models) plus `clinic`, `user`, `patient`, `visit`, `hospitalization`, `product`, `inventory`, `prescription`, `pharmacy`, `examResult`, `insurance`, `insuranceClaim`, `invoice`, `payment`, `refund`, `discount`, `expense`, `queue`, `department`, `schedule`, `notifications`, `activity`, `approval`, `demoRequests`, `medicalRecord`, `patient-portal`, `spectaclePrescription`, `staff_timesheet`, `sms`, `purchasing`.
- **Migrations:** `prisma/migrations/`, naming `YYYYMMDDHHMMSS_description`. Seed: `prisma/seed.ts`.
- **Redis:** `ioredis` singleton in `src/services/redis.service.ts` — `getCachedData(key, fn, ttl)`, invalidators, `DEFAULT_CACHE_TTL` (SHORT 5m / MEDIUM 1h / LONG 24h), structured `CACHE_KEYS`. Requires `REDIS_HOST`.

### Domain model (high level)
Multi-tenant clinic OS rooted at **Clinic** (tenant) → **Branch** (sub-tenant), with **ClinicFlowConfig** parameterizing which care-flow stages run. **User** = staff or patient-linked account (13-role enum). **Patient** → many-to-many with clinics/branches. **Visit** is the central encounter: a `VisitStatus` lifecycle plus an additive `CareStage` pipeline (RECEPTION/TRIAGE/DOCTOR/LAB/PHARMACY/BILLING/DONE), owning triage, diagnoses (ICD-11), exams, prescriptions, payments, handoffs, queue entries, and hospitalization. **Hospitalization/Ward** (inpatient): `Ward → Bed → Hospitalization` (1:1 with a Visit) with `WardObservation` (vitals + EWS), `WardMedication` + MAR, `ProgressNote`, `WardOrder`, `BedTransfer`, `DischargeSummary`, and a `WardCharge` ledger settling into the visit's Payment on discharge. Supporting domains: **Product** catalog (tiered/insurer/clinic pricing, ICD-11/LOINC/tariff codes), **Inventory** (item → stock/batch/transaction, purchasing), **Prescription** (item fulfilment INTERNAL/EXTERNAL → pharmacy dispense), **Exams/Labs** (`Exam`/`ExamTest`/`ExamResult`), **Billing/Insurance** (Payment, Invoice, Discount, Refund, InsuranceClaim), **Queue/flow** (`Queue`/`QueueEntry`/`QueueConfig` — see `QUEUELESS_DOCS.md`), and cross-cutting `ActivityLog`, `Notification`, `OutboundSmsLog`, `Approval`, `StaffTimesheet`, scheduling/appointments.

### Path aliases
`tsconfig.json`: `@/*` → `./src/*`, `generated/*` → `./generated/*`. Module resolution is `bundler` with `allowImportingTsExtensions` — many imports use explicit `.ts` extensions. The Prisma client is imported by relative path, not the alias.

### Testing conventions
- Tests are colocated in `__tests__/` dirs (e.g. `src/lib/__tests__/`, `src/services/__tests__/`, `src/api/v1/exams/__tests__/`).
- **Runner note:** the `test` script is `bun test`, but existing test files are authored against **Vitest** APIs (`vi`, `describe`, `it`, `expect`; `vitest/globals` in `tsconfig.test.json`). There is no `vitest.config.*` or `bunfig.toml` — confirm how the team runs a given suite before assuming.
- Existing tests use **mocks** (`vi.mock("@/database/db", …)`), not a real DB. There is no `.env.test` and no coverage threshold configured. `NODE_ENV=test` disables cron startup.

### External services
- **File storage:** Cloudflare R2 via a custom Worker (`src/services/cloudflare-r2.service.ts`, `PUT` to `CLOUDFLARE_WORKER_URL` with `CLOUDFLARE_AUTH_SECRET`). No AWS SDK / MinIO / S3.
- **Email:** Resend (`src/services/email.service.ts`) + Handlebars templates in `src/templates/`.
- **SMS/voice:** Twilio (`src/services/twilio.provider.ts`, `sms.service.ts`), delivery logged in `OutboundSmsLog`, SMS retry cron.
- **WhatsApp:** WhatsApp Cloud API (`src/services/whatsapp.service.ts`).
- **Realtime:** Socket.io (`src/lib/socket.ts`) — rooms `queue:<id>`, `entry:<id>`, `flow:<id>`, authenticated via Better-Auth.
- **reCAPTCHA:** `src/lib/recaptcha.ts` + middleware (see `docs/RECAPTCHA_TESTING.md`).
- **Cron:** `src/jobs/` (node-cron) — inventory expiry, insurance claims, queue scheduler, SMS retry — started by `startRecurringJobs()`.
- **Payments:** no third-party gateway; payments are internal DB models.

### Environment
`.env.example` is stale/incomplete versus the real `.env`. Key vars the code actually reads include: `DATABASE_URL`, `AUTH_SECRET`, `APP_URL`, `BACKEND_URL`, `NEXT_UP_URL`, `PORT`, `REDIS_HOST/PORT/PASSWORD/USERNAME/DATABASE`, `RESEND_API_KEY`, `EMAIL_FROM_NAME/ADDRESS`, `COOKIE_DOMAIN`, `SOCKET_API_SECRET/SOCKET_URL`, `CLOUDFLARE_WORKER_URL/AUTH_SECRET`, `CRON_SECRET_KEY`, `SESSION_CACHE_TTL_MS`, `WHATSAPP_*`, `TWILIO_*`, `RECAPTCHA_ECLINIC_SECRET`. When adding a var, read it through the code, not `.env.example`.

## Agentic & Subagent Boundaries

- **DO NOT** spawn autonomous subagents for basic syntax queries, single-file edits, or simple git status checks.
- **RESTRICT** subagent usage exclusively to heavy multi-file refactoring, deep codebase analysis, or isolated research tasks.
- **MANDATORY**: Always ask for explicit user confirmation before initiating any subagent loops that exceed 3 sequential steps.
- **MODEL CONSTRAINTS**: When creating custom subagents via `/agents`, always default to the `Haiku` model for non-critical code reviews or logs to conserve tokens.
- **DO NOT GIT COMMIT THE CHANGES UNLESS INSTRUCTED TO DO SO**: I'll be committing myself.

# INSTRUCTIONS

- Any code we write, we don't use `any` as a type.
- We never turn off TypeScript or lint rules to make something pass.
- Validate at boundaries with **Zod v4** and the `validate(...)` middleware; return errors through `AppError` / the global handler, not ad-hoc JSON.
- New/edited controllers should use the `jsonSuccess` / `jsonError` envelopes, gate auth through `crudAccess` (or `requirePermission`), and scope queries by tenant (`getScope`/`withScope` or explicit `clinicId`).
- **NEVER edit an already-applied migration.** Any schema change requires a **new** migration — never modify an existing one.
- Respect multi-tenancy: no query returning clinic data may run without a resolved `clinicId`/`branchId` scope (except explicit `SUPER_ADMIN` paths).
- **AS SOON AS A NEW PERMISSION/RESOURCE/ACTION IS ADDED**, update `src/lib/permissions.ts` (`ROLE_PERMISSIONS`) and, where relevant, the entitlements matrix.
- Consider runtime complexity and payload size — endpoints are consumed on mobile, so avoid over-fetching and heavy responses.
- ALWAYS MAKE A PLAN FIRST, UNLESS I ASK YOU TO NOT DO IT.
