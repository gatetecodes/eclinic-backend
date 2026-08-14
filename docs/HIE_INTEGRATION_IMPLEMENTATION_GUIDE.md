# Rwanda HIE Integration — Implementation and Verification Guide

**System:** CareLogic backend and web frontend  
**Documentation snapshot:** 2026-08-12 (Africa/Kigali)  
**Backend snapshot:** `19ffbc1` (`fix: fixes based on review`)  
**Contract snapshot:** `docs/rhie-swagger-2026-08-11.yaml`, SHA-256 `67d230d279b6ebfdf68059b3353171538f90d31a04af64fb9449dd1e7d935f05`  
**Audience:** engineers, QA, clinic administrators, security/compliance reviewers, and future maintainers

> **Status in one sentence:** the implementation is code-complete for the pinned RHIE FHIR R4 contract surface described here, but every tenant capability is disabled by default and production activation still depends on MoH confirmation, operational approvals, secure connectivity, verified national mappings, and a completed rollout process.

## 1. Purpose and scope

CareLogic integrates with the Rwanda Health Information Exchange (RHIE) through the backend. The integration covers:

- national patient identity lookup, human-reviewed linking, deferred/offline verification, retry, and duplicate/conflict resolution;
- local sharing consent with asynchronous RHIE synchronization and withdrawal;
- read-only retrieval of an International Patient Summary (IPS) and a sectioned national record;
- audited emergency “break glass” national-record access;
- publication of finalized encounters and coded clinical resources through a durable outbox;
- explicitly structured consultation observations, allergies, immunizations, imaging orders, and imaging metadata;
- outbound and inbound inter-facility transfer workflows;
- terminology, facility, practitioner, coverage, date-of-birth, and emergency-access governance;
- tenant-scoped operational metrics, alerts, retries, and audit views; and
- frontend workflow placement at reception, the patient chart, consultation, inventory/terminology administration, and clinic HIE setup.

The integration intentionally does **not** create national `Patient` resources, overwrite local demographics from national data, automatically import external clinical records into local orders/diagnoses/billing, or transmit imaging binaries.

## 2. Where HIE sits in the CareLogic process flow

### 2.1 End-to-end flow

```text
Platform administrator
  enables clinic HIE entitlement (disabled in every plan by default)
        │
Clinic administrator
  saves TEST/PRODUCTION tenant capabilities
  verifies branch → FOSA/Location mappings
  verifies staff → Practitioner mappings
  verifies destination facilities and terminology
        │
Reception / cashier / nurse
  NID + birth-date lookup → review national/local demographics
  → link existing/new local patient OR defer verification
        │
Authorized staff
  records active sharing consent → Consent outbox event → RHIE
        │
Normal CareLogic care flow continues
  triage → consultation → labs → prescriptions → pharmacy → inpatient care
        │
Local finalization transaction
  commits local clinical state + encrypted/idempotent HIE outbox events
        │
Minute worker
  dependency checks → FHIR mapping → allowlisted backend request → RHIE
  → resource link + attempt/audit status, or bounded retry/dead letter
        │
Patient chart / HIE administration
  read national history, reconcile external items, manage transfers,
  review alerts, retry failures, and resolve compliance queues
```

### 2.2 Workflow placement by user task

| CareLogic process point | HIE behavior | Primary UI/backend trigger |
| --- | --- | --- |
| Platform setup | Enables the otherwise-disabled `hie` entitlement; governs global clinical/product terminology | Platform admin pages and entitlement overrides; `src/lib/entitlements-matrix.ts`; admin terminology controllers |
| Clinic setup | Configures environment and capability flags; maps branch, practitioner, and transfer destinations | Dashboard **Setup → Rwanda HIE**; `HieAdministrationPanel`; `/api/v1/hie/config`, `/facilities`, `/practitioners`, `/destinations` |
| Reception/check-in | Verifies NID + DOB, compares national demographics with local candidates, links only after review, or records deferred/no-match state | `reception-check-in-form.tsx`; `/patients/lookup`, `/patients/link`, `/patients/defer-verification` |
| Patient chart | Shows link state, consent, read-only national record, structured HIE records, and transfers when capabilities permit | `patient-chart.tsx` plus components under `src/features/hie/components/` |
| Consultation | Collects structured route/method details required for medication publication; finalized visits trigger encounter/condition/vitals/clinical event enqueueing | `consultation-screen.tsx`; visit finalization controller; outbox mapper/service |
| Lab | Completed coded lab results enqueue current clinical resources | `exams.controller.ts` → `enqueueCurrentClinicalEventsInTransaction` |
| Prescription | Issued/updated structured prescriptions enqueue medication requests | prescription controller → current-clinical-event enqueue |
| Pharmacy | Successful dispense transaction enqueues medication dispense resources | `pharmacy-dispense-run-tx.ts` → current-clinical-event enqueue |
| Hospitalization | Ward observations, medications/administrations, and discharge enqueue relevant resources; discharge creates an IPS bundle | hospitalization controller → current clinical/discharge enqueue |
| Transfer | Doctor creates a draft from a finalized visit, then queues independent Transfer Encounter and IPS events | Patient chart transfer tab; `/transfers*`; outbox worker |
| Operations/compliance | Reviews outbox, retry/dead-letter state, identity conflicts, emergency access, DOB discrepancies, coverage mappings, national audit, and readiness | HIE setup panels; operations/governance controllers and services |

## 3. Runtime architecture

### 3.1 Request path

Authenticated requests flow through:

```text
src/index.ts
  → /api
  → src/routes/index.ts (v1 is mounted at /v1 and /)
  → src/api/v1/index.ts
  → authentication
  → tenantContext
  → entitlementsContext
  → /hie router
  → requireFeature("hie")
  → resource/action permission
  → Zod request validation
  → tenant-scoped controller/service
```

Canonical endpoints are documented as `/api/v1/hie/...`; because the v1 router is also mounted at `/api`, aliases under `/api/hie/...` currently exist. Tests and external documentation should use `/api/v1` so a future alias removal does not break clients.

### 3.2 External connectivity boundary

Only `src/services/hie/rhie-client.ts` sends RHIE HTTP requests. It:

- selects either the Client Registry or Shared Health Record (SHR) base URL;
- verifies tenant, deployment, endpoint, and credential environments all match;
- rejects HTTP in production, even if the test override is present;
- restricts method/path/body/response combinations through the typed registry in `rhie-endpoints.ts`;
- applies Basic authentication and a correlation ID backend-side;
- limits responses to 2 MiB and requests to the configured timeout (8 seconds by default);
- retries only safe GET operations on network, HTTP 429, and 5xx conditions;
- never transport-retries POST requests;
- opens an in-process, per-service circuit for 30 seconds after five retryable failures; and
- logs service, method, resource class, status/code, attempts, duration, and correlation ID—not credentials, patient identifiers, raw FHIR, or OperationOutcome diagnostics.

### 3.3 Durable publication path

Clinical writes use a transactional outbox:

1. The normal local clinical transaction updates CareLogic data.
2. If HIE and the relevant write capability are enabled, the same transaction inserts an encrypted `HieOutboxEvent` snapshot.
3. Missing patient identity, synchronized consent, terminology, facility, practitioner, encounter, coverage, or upstream resource references make the event `BLOCKED`; they do not fail the local care transaction.
4. Every minute the worker recovers missing finalized-visit events, retries deferred identities, and processes due outbox events.
5. The worker claims an event, revalidates dependencies, maps the snapshot to a validated FHIR request, and sends it through `rhieRequest`.
6. Success creates/updates `HieResourceLink`, records `HieSyncAttempt`, and marks the event `SUCCEEDED`. Retryable failures move it to `RETRY`; exhausted failures become `DEAD_LETTER`; unresolved dependencies remain `BLOCKED` on a bounded schedule.

This design keeps local care available during HIE downtime and prevents an already-committed clinical event from being lost merely because the immediate enqueue path was missed: `recoverMissingFinalizedVisitEvents` scans finalized visits older than five minutes with no Encounter event.

### 3.4 Scheduler

`src/jobs/hie-outbox.cron.ts` registers:

- `* * * * *`: finalized-visit recovery, pending-identity retry, and outbox processing;
- `*/5 * * * *`: tenant operational monitoring and redacted alert logging.

Recurring jobs start from `src/index.ts` when it is the main module and `NODE_ENV !== "test"`. The implementation assumes a deployment topology in which duplicate scheduler execution is acceptable because event claiming and idempotency prevent duplicate publication. If multiple application replicas run, confirm database claiming behavior under production load and consider a dedicated worker/leader election as an operational hardening step.

## 4. Safety, privacy, tenancy, and authorization

### 4.1 Layered activation

An RHIE feature is callable only when all applicable layers pass:

1. authenticated CareLogic session;
2. resolved tenant/branch scope;
3. clinic `hie` entitlement (false for `CLINIC_STARTER`, `MEDICAL_PLUS`, and `HOSPITAL_SUITE` by default);
4. HIE RBAC permission for the route action;
5. enabled `HieTenantConfig` and matching environment;
6. relevant per-capability flag; and
7. resource-specific prerequisites, such as verified mappings, linked patient, synchronized consent, finalized local state, or verified terminology.

The principal capability flags are `clientRegistry`, `sharedRecordRead`, `sharedRecordWrite`, `transfer`, `consentSync`, `consultationWrite`, `nationalListRead`, `nationalAuditRead`, `emergencyRead`, `allergyWrite`, `immunizationWrite`, and `imagingWrite`.

### 4.2 Roles

- `CLINIC_ADMIN`: full clinic HIE configuration, processing, consent, transfer, emergency review, and structured clinical management.
- `BRANCH_ADMIN`: branch-scoped read/create/update/identity/consent/transfer functions; not the clinic-wide processing surface.
- `DOCTOR`: read/create, consent, outbound/inbound transfer, emergency read, allergy, immunization, and imaging functions. Transfer creation is additionally hard-restricted to `DOCTOR` in the controller.
- `NURSE`: read/create/identity approval, consent, allergies, and immunizations.
- `LAB_TECHNICIAN`: HIE read and imaging management.
- `RECEPTIONIST` and `CASHIER`: read/create, identity approval, and consent.
- `SUPER_ADMIN`: implicit permission bypass, with global terminology managed under the separate super-admin routes.
- Other roles have no HIE grant unless explicitly present in the matrix.

Always treat `src/lib/permissions.ts` in both repositories as the current source of truth; the route uses a specific action such as `manageHieConsent`, `manageHieTransfers`, `emergencyHieRead`, or `process`, not just generic read/update.

### 4.3 Sensitive data protection

- `HIE_DATA_ENCRYPTION_KEY` is a 32-byte AES-256-GCM key. Values are stored as a randomized, authenticated `v1.<iv>.<tag>.<ciphertext>` envelope.
- `HIE_IDENTIFIER_HASH_KEY` is a separate 32-byte HMAC-SHA-256 key. Normalized NIDs, UPIDs, FHIR IDs, coverage references, and other lookup identifiers can be uniquely indexed without storing plaintext.
- The HMAC key must remain stable across data-encryption-key rotations; changing it breaks deterministic equality/uniqueness lookups.
- Identifiers and raw payloads are encrypted in `PatientExternalIdentity`, `UserExternalIdentity`, `HieResourceLink`, `HieOutboxEvent`, `HieReconciliation`, inbound transfers, and consent fields as appropriate.
- Raw national FHIR bundles are summarized server-side. The browser receives a minimal provenance view, not the national patient identifier or reusable resource ID.
- Reconciliation uses an encrypted, patient-bound, expiring opaque token. The controller rejects malformed, expired, or cross-patient tokens before storing the review.
- Application audit records store action/outcome/correlation and redacted metadata, rather than authorization headers or raw clinical payloads.

## 5. Implemented workflows

### 5.1 Tenant configuration and readiness

The clinic administrator opens Dashboard **Setup → Rwanda HIE**. The status endpoint returns enabled capabilities, environment, non-secret connection readiness, health, verified-facility counts, and whether the actor may manage configuration. No secret is returned.

Activation validates:

- `HIE_DEPLOYMENT_ENVIRONMENT` exists and equals the requested tenant environment;
- endpoint and credential environment labels match;
- Basic-auth credentials, encryption keys, and both base URLs are configured;
- production URLs use HTTPS; and
- only intentionally enabled capabilities are saved.

Facility mappings bind a CareLogic branch to a unique national FOSA code and FHIR `Location` reference. Practitioner mappings encrypt and hash the national Practitioner reference. Destination facilities are clinic-scoped verified records used by transfers. Mapping inputs include verification status/source/reference/actor, optional expiry, and audit history. The UI also exposes HIE operations and governance panels to clinic administrators.

### 5.2 Patient identity at reception

The reception form exposes national lookup only when the entitlement/configuration and Client Registry capability are enabled. Lookup requires a validated 16-digit NID and date-only birth date.

Flow:

1. The backend calls Client Registry `GET /Patient` with the allowed query.
2. Successful data is validated as FHIR and filtered to exact normalized NID and DOB matches.
3. CareLogic searches local candidates and prioritizes an already-verified identity match, then demographic candidates.
4. The user sees national and local demographic values side-by-side.
5. Linking requires explicit review and an optimistic `expectedUpdatedAt` value so a concurrently edited local patient is not silently linked.
6. The backend stores encrypted NID/UPID/resource IDs, HMAC lookup hashes, a protected demographic snapshot, verification state, and an audit event.
7. National demographics are **not** copied over the local patient record. Differences remain visible for human handling; DOB differences enter a dedicated remediation queue.

If Client Registry is unavailable, the user can follow an alternate path and record a stable defer reason (`SERVICE_UNAVAILABLE`, `PATIENT_UNABLE_TO_CONFIRM`, or `OTHER`). Pending identities are retried by the minute worker with a stored encrypted DOB snapshot. A unique NID/UPID already linked to another local patient produces an `HieIdentityReconciliation` case rather than a silent merge.

No-match, deceased-patient, malformed-response, conflict, and stale-local-record states are explicitly handled. CareLogic patient registration/check-in remains usable when HIE is unavailable.

### 5.3 Consent lifecycle

Authorized staff record scope, purpose, effective dates, and evidence method (`WRITTEN`, `VERBAL`, or `ELECTRONIC`) with affirmative patient confirmation and optional witness/document/note evidence.

- Local consent becomes active immediately under local policy.
- If consent synchronization is enabled, a deterministic, encrypted `Consent` outbox event is queued.
- Clinical publication requires an active **and synchronized** consent within its effective interval.
- Withdrawal is immediately effective locally and sets withdrawal metadata before the remote delete completes.
- Remote `DELETE /Consent/{id}` is durable and idempotent; RHIE 404 is treated as success.
- A reconciliation action can compare/repair local sync state against national consent state.
- When a verified identity and qualifying consent become available, previously patient-dependency-blocked events are resumed.

### 5.4 Read-only national record and reconciliation

The patient chart can retrieve:

- an IPS view; or
- independently requested sections: encounters, observations, conditions, allergies, immunizations, service requests, medications (request/dispense/administration), procedures, imaging, transfers, and consents.

The sectioned service runs at most four section workers concurrently. A section failure is represented as safe code/retryability metadata; other sections still return and the overall response is marked `partial`. Results are deduplicated by resource type and ID, summarized to browser-safe provenance records, and not persisted as local clinical truth.

A clinician may mark an external item `ACCEPTED` as history or `DISMISSED`, with notes and optional local-resource reference. This creates/updates a `HieReconciliation` record. It does not automatically create a diagnosis, medication, order, invoice, or treatment.

### 5.5 Emergency access

When ordinary read consent is unavailable but emergency access is enabled, an authorized doctor can create a time-bounded read-only access record with a reason code and justification. The controller records actor, branch, patient, effective interval, outcome, and audit trail. The resulting national record is still summarized/read-only.

Clinic administrators review each break-glass event as `APPROVED` or `CONCERN` with a note. Pending reviews and expirations appear in operations/compliance readiness. Emergency access does not authorize national writes.

### 5.6 Finalized encounter and clinical publication

Finalizing a visit calls `enqueueFinalizedVisitInTransaction` inside the local finalization transaction. When shared-record write is enabled, it creates:

- Encounter (`dependencyOrder` 10);
- optional consultation Encounter (`20`);
- confirmed ICD-11 Condition records;
- numeric LOINC/UCUM vital-sign Observations;
- coded lab ServiceRequests and completed lab-result Observations;
- structured MedicationRequests, MedicationDispenses, and MedicationAdministrations;
- verified ICHI Procedures;
- inpatient/ward vital Observations; and
- other finalized structured records supported by the capability map.

The extended clinical enqueue is also called when relevant labs, prescriptions, dispenses, and hospitalization data change. Existing aggregate/resource keys and unique idempotency keys prevent duplicate outbox rows.

Publication prerequisites are deliberately strict:

- verified patient Client Registry resource reference;
- active synchronized consent;
- verified branch/Location and practitioner mappings;
- existing national Encounter link for dependent resources;
- verified standardized terminology (ICD-11, LOINC, SNOMED CT, ICHI, NPC/approved concept system as applicable);
- structured medication dose, frequency, route, duration, and administration method when required;
- verified Coverage for medication requests when the mapped workflow requires it; and
- upstream MedicationRequest/ServiceRequest links before dispense, administration, or result resources.

Free-text diagnoses and placeholder lab values are never substituted for standardized values. Events remain `BLOCKED` with actionable dependency reasons.

### 5.7 Explicit structured clinical records

The patient chart has dedicated local models and CRUD/finalization workflows for:

- consultation observations;
- clinician-reviewed structured allergies;
- structured immunizations;
- imaging ServiceRequest metadata; and
- ImagingStudy/series/instance metadata.

Only active, `VERIFIED` `HieClinicalConcept` records can be selected. Draft records remain local. Finalization changes the local status and creates an idempotent outbox event only when the matching capability is enabled. Allergy/immunization corrections use replacement semantics: the original is marked `CORRECTED` and the replacement is a new record; delete/correction publication is explicit and auditable.

Imaging stores DICOM identifiers and descriptive metadata—not image pixels or a PACS archive. Study, series, SOP UIDs, modality, dates, concepts, and conclusion metadata are validated before finalization.

### 5.8 Inpatient discharge

Discharge runs in the hospitalization transaction after CareLogic has a discharge summary and `DISCHARGED` visit. `enqueueDischargeInTransaction` ensures an Encounter is available/queued and adds a `DischargeIPS` bundle snapshot containing the escaped, locally authored summary, final diagnosis, instructions, follow-up, destination, and references. HIE failure cannot undo the completed local discharge.

### 5.9 Inter-facility transfer

Inter-facility HIE transfers are distinct from internal bed transfers and clinician handoffs.

Outbound flow:

1. A doctor selects a finalized visit and a verified destination.
2. The controller requires a branch-scoped, verified source facility and rejects a destination equal to the source.
3. A local `DRAFT` `HieExternalTransfer` records the clinical summary, reason, urgency, source, destination, patient, visit, and practitioner.
4. Queueing atomically claims `DRAFT`/`FAILED` and creates two independent idempotent events: `TransferEncounter` (order 20) and `TransferIPS` (21).
5. Worker success changes the transfer toward `SENT`; failures are visible/retryable. The API protects against concurrent double-queueing.
6. Cancellation is allowed only for draft/queued/failed work. It is rejected while an event is `PROCESSING`; pending retryable events are blocked as cancelled.

Inbound flow:

1. Authorized staff refresh `Encounter/$list-transfers` for a linked patient.
2. Only encounters explicitly coded/text-marked `TRANSFER_ENCOUNTER` are imported.
3. External IDs and raw payloads are hashed/encrypted; the browser sees a safe summary.
4. Local status moves through received/reviewed/acknowledged/completed/dismissed with local reviewer and notes.

The pinned Swagger has no remote mutation for transfer acknowledgement, so acknowledgement/completion remains a local operational state.

### 5.10 Operations, audit, and governance

The operations summary is clinic-scoped and reports outbox status counts, resource volumes, success/failure rates, average latency, retry age, blocked reasons, terminology/mapping readiness, emergency review backlog, contract metadata, and external prerequisites. Alerts include dead letters, stale work, degraded health, unverified/expired mappings, pending emergency reviews, and elevated failure rate. `HIE_ALERT_STALE_MINUTES` controls stale age (30 minutes by default).

The governance UI covers:

- pending/deferred identities and manual retry;
- identity conflict cases and audited resolution/dismissal;
- outbox inspection and authorized retry;
- facility, practitioner, destination, and Coverage mappings;
- DOB discrepancy refresh/correct/dismiss with optimistic concurrency;
- emergency access review;
- local HIE audit and national AuditEvent read; and
- global HIE clinical-concept/product-terminology verification by platform administrators.

## 6. Data model

`prisma/schema/hie.prisma` is the center of persistence. Important models are grouped below.

### 6.1 Configuration and mappings

- `HieTenantConfig`: environment, global enablement, individual capabilities, and last health result.
- `HieFacilityLink`: CareLogic branch → FOSA/Location with verification evidence and expiry.
- `HieDestinationFacility`: clinic-approved transfer destinations.
- `UserExternalIdentity`: staff → encrypted/hashed national Practitioner reference.
- `PatientInsuranceExternalIdentity`: CareLogic policy → national Coverage reference.

### 6.2 Identity and consent

- `PatientExternalIdentity`: NID/UPID/resource reference, protected demographic snapshot, verification/retry state.
- `HieIdentityReconciliation`: uniqueness/concurrency conflict case; never an automatic merge.
- `HieDobDiscrepancy`: local/national date-only discrepancy and review state.
- `HieConsent`: local consent evidence, effective window, remote identifiers/version, and sync state.

### 6.3 Publication and provenance

- `HieOutboxEvent`: encrypted immutable publication snapshot, dependency order/reason, attempts, correlation/idempotency keys, lock and terminal state.
- `HieSyncAttempt`: per-attempt outcome, safe error details, latency, and HTTP status.
- `HieResourceLink`: local aggregate → encrypted remote FHIR ID/version.
- `HieAuditEvent`: tenant/actor/patient action, capability, purpose, outcome, correlation, redacted metadata.
- `HieReconciliation`: clinician decision about a retrieved external resource.

### 6.4 Structured clinical and transfer data

- `HieClinicalConcept`, `HieConsultationObservation`, `HieStructuredAllergy`, `HieImmunization`;
- `HieImagingOrder`, `HieImagingStudy`, `HieImagingSeries`, `HieImagingInstance`;
- `HieEmergencyAccess`;
- `HieExternalTransfer` and `HieInboundTransfer`.

The schema is introduced/evolved by migrations from `20260807110000_rwanda_hie_foundation` through `20260812163000_hie_clinical_relations`. Never edit an applied migration; add a new migration for future changes.

## 7. API inventory

All routes below are entitlement-, tenant-, RBAC-, and Zod-gated under `/api/v1/hie`.

### 7.1 Status, configuration, mappings, and governance

- `GET /status`; `PUT /config`
- `GET /mappings`; `PUT /facilities`; `PUT /practitioners`; `PUT /destinations`
- `GET /concepts`
- `GET|PUT /coverage-mappings`
- `GET /national-audit`
- `GET /dob-discrepancies`; `POST /dob-discrepancies/refresh`; `POST /dob-discrepancies/:id/resolve`
- `GET /audit`
- `GET /operations/summary`

### 7.2 Identity

- `POST /patients/lookup`; `POST /patients/link`; `POST /patients/defer-verification`
- `GET /patients/:patientId/identity`
- `GET /identities/pending`; `POST /identities/:identityId/retry`
- `GET /identity-cases`; `PUT /identity-cases/:caseId`

### 7.3 National read, emergency access, consent, and reconciliation

- `GET /patients/:patientId/ips`
- `GET /patients/:patientId/national-record`
- `POST /patients/:patientId/emergency-access`
- `GET /emergency-access`; `POST /emergency-access/:id/review`
- `GET /patients/:patientId/consent`; `POST /patients/:patientId/consent/reconcile`
- `POST /consents`; `POST /consents/:consentId/withdraw`
- `POST /reconciliations`

### 7.4 Structured clinical records

- consultation observations: patient list/create and `POST /consultation-observations/:id/finalize`;
- allergies: patient list/create plus update, delete, finalize, and correct;
- immunizations: patient list/create plus update, delete, finalize, and correct;
- imaging: patient list, order/study create, and order/study finalize.

Exact paths and required actions are centralized in `src/api/v1/hie/hie.routes.ts`.

### 7.5 Operations and transfer

- `GET /outbox`; `POST /outbox/:eventId/retry`
- `GET|POST /transfers`; `GET /transfers/:transferId`
- `POST /transfers/:transferId/queue`; `POST /transfers/:transferId/cancel`
- `POST /patients/:patientId/inbound-transfers/refresh`
- `GET /inbound-transfers`; `PUT /inbound-transfers/:inboundTransferId`

Global product and HIE clinical-concept governance is under the super-admin `/api/v1/admin` route surface, not the tenant HIE router.

## 8. Key files and components

### 8.1 Backend core

| File or area | Responsibility |
| --- | --- |
| `src/api/v1/hie/hie.routes.ts` | Complete tenant HIE route, permission, and validation map |
| `src/api/v1/hie/hie.controller.ts` | Configuration, identity, consent, national read/reconciliation, audit/outbox, and transfer workflows |
| `src/api/v1/hie/clinical.controller.ts` | Structured consultation/allergy/immunization/imaging CRUD, finalization, correction, and enqueue |
| `src/api/v1/hie/governance.controller.ts` | Coverage mapping, DOB remediation, and national audit |
| `src/api/v1/hie/*.validation.ts` | Zod v4 request boundary contracts |
| `src/services/hie/rhie-client.ts` | Environment/transport/auth/retry/size/circuit/logging boundary |
| `src/services/hie/rhie-endpoints.ts` | Allowlisted pinned method/path/request/response registry |
| `src/services/hie/fhir.schemas.ts` | Runtime FHIR resource/bundle validation |
| `src/services/hie/outbox.service.ts` | Event discovery, encrypted snapshots, dependency resolution, FHIR publication, retry/recovery/idempotency |
| `src/services/hie/client-registry.service.ts` | Exact NID+DOB Client Registry lookup and FHIR match normalization |
| `src/services/hie/pending-identity.service.ts` | Deferred/offline identity retry and conflict creation |
| `src/services/hie/national-record.service.ts` | Sectioned, partially resilient, bounded-concurrency national read |
| `src/services/hie/shared-record.service.ts` | IPS fetch and browser-safe provenance summaries |
| `src/services/hie/hie-crypto.service.ts` | AES-GCM encryption and HMAC identifiers |
| `src/services/hie/hie-resource-id.ts` | Environment/tenant/resource-scoped UUIDv5 and idempotency keys |
| `src/services/hie/*mapper.ts` | Deterministic FHIR mapping for encounters, conditions, vitals, consent, consultation, clinical resources, discharge, and deferred structured data |
| `src/services/hie/operations-metrics.service.ts` | Tenant metrics, readiness, and alert construction/monitoring |
| `src/jobs/hie-outbox.cron.ts` | Minute processing/recovery and five-minute monitoring |
| `prisma/schema/hie.prisma` | HIE data model and lifecycle enums |

### 8.2 Backend integration points modified outside HIE

- `src/api/v1/index.ts`: mounts `/hie` after authentication/tenant/entitlement middleware.
- `src/api/v1/visits/controllers/core.controller.ts`: visit finalization enqueue.
- `src/api/v1/exams/exams.controller.ts`: completed lab event enqueue.
- `src/api/v1/visits/controllers/prescription.controller.ts`: prescription event enqueue.
- `src/services/pharmacy-dispense-run-tx.ts`: dispense event enqueue.
- `src/api/v1/hospitalization/hospitalization.controller.ts`: ward/discharge event enqueue.
- `src/api/v1/inventory/inventory.controller.ts` and admin terminology controllers: verified-code governance.
- `src/lib/permissions.ts`, `src/types/access.ts`, and `src/lib/entitlements-matrix.ts`: HIE resource/actions and default-off entitlement.
- `.env.example`: backend HIE runtime configuration.

### 8.3 Frontend

| File or area | Responsibility |
| --- | --- |
| `src/features/hie/actions/hie.ts` | Authenticated server-side backend API adapter; keeps credentials/cookies server-side |
| `src/features/hie/server/hie-queries.ts` | TanStack Start server functions with Zod validators |
| `src/features/hie/hooks/*` | Query/mutation/cache orchestration for each HIE workflow |
| `src/features/hie/lib/hie.schemas.ts` / `hie.types.ts` | Client/server-function validation and UI types |
| `src/features/hie/components/national-identity-lookup.tsx` | Lookup, no-match/defer, local candidate, and demographic review flow |
| `src/features/hie/components/national-record-panel.tsx` | Read-only sectioned national history and reconciliation |
| `src/features/hie/components/hie-consent-panel.tsx` | Consent grant/withdraw/reconcile UI |
| `src/features/hie/components/structured-clinical-panels.tsx` | Structured observations, allergy, immunization, and imaging UI |
| `src/features/hie/components/patient-transfer-panel.tsx` | Outbound/inbound transfer UI |
| `src/features/hie/components/hie-administration-panel.tsx` | Tenant capabilities and mappings |
| `src/features/hie/components/hie-operations-panel.tsx` and summary | Outbox filters/retry, metrics, readiness, alerts |
| `src/features/hie/components/hie-governance-panel.tsx` and compliance panel | Identity cases/audit and compliance remediation |
| `src/features/flow/components/forms/reception-check-in-form.tsx` | Inserts HIE identity into the real reception/check-in flow |
| `src/features/patients/components/patient-chart.tsx` | Capability-driven HIE tabs and panels |
| `src/features/flow/components/screens/consultation-screen.tsx` | Structured medication route/method capture |
| `src/routes/$locale.dashboard.setup.tsx` and `src/lib/menuItems.ts` | Setup tab/navigation placement |
| `src/lib/apiEndpoints.ts`, `src/lib/permissions.ts`, `src/i18n/messages.ts` | Endpoint catalog, UI gating, and English/French text |

> **Working-tree warning:** at this documentation snapshot, the frontend HIE feature directory is untracked and its integration points are modified but uncommitted. Preserve/commit that work before switching branches, cleaning the repository, or handing it to CI. The backend HIE lineage is committed (notably `ee51b6a`, `59cc1b1`, `398872b`, and subsequent review fixes).

## 9. Important code patterns

### 9.1 Environment-scoped deterministic identity

```ts
return uuidv5(
  [environment, String(clinicId), localResourceType, localResourceId, hieResourceType].join(":"),
  HIE_RESOURCE_NAMESPACE
);
```

The environment and clinic are part of the namespace value, so TEST and PRODUCTION cannot accidentally reuse a resource identity and two clinics cannot collide for equal local IDs.

### 9.2 Sensitive value protection

```ts
const cipher = createCipheriv("aes-256-gcm", encryptionKey(), randomBytes(12));
// Stored envelope: v1.<iv>.<authentication-tag>.<ciphertext>

createHmac("sha256", identifierHashKey())
  .update(value.trim().toUpperCase())
  .digest("hex");
```

Encryption protects recoverable values; the separate keyed hash supports equality/uniqueness without plaintext.

### 9.3 Local transaction plus outbox

```ts
await enqueueFinalizedVisitInTransaction(tx, {
  clinicId,
  visitId,
  patientId,
});
```

The enqueue occurs inside the same Prisma transaction as finalization. The function exits without an HIE event when the capability is off, but creates a blocked event when HIE is on and a recoverable dependency is missing.

### 9.4 Patient dependency handling

```ts
status: dependencyReason ? "BLOCKED" : "PENDING",
dependencyReason,
nextAttemptAt: now,
```

Verified identity is checked before synchronized active consent. When both later exist, `resumeBlockedPatientEvents` changes only the known patient-dependency-blocked events back to `PENDING`; unrelated terminology/mapping failures are not incorrectly released.

### 9.5 GET-only transport retry

```ts
const maxAttempts = params.method === "GET" ? getMaxAttempts() : 1;
```

POST replay is controlled at the durable business-event layer, where idempotency and outcome are persisted, rather than blindly retried by the HTTP client.

### 9.6 Partial national-record retrieval

```ts
await Promise.all(
  Array.from({ length: Math.min(4, sections.length) }, () => worker())
);
return { sections: results, partial: results.some((item) => item.status === "FAILED") };
```

One unavailable national section does not erase all usable history and at most four sections are fetched concurrently.

## 10. Dependencies and configuration

### 10.1 Runtime dependencies

- Bun/Hono backend, Prisma 7 with PostgreSQL, Zod v4, `node-cron`, Node crypto, and `uuid` v5.
- TanStack Start/React frontend, Axios server adapter, TanStack Query/Table, React Hook Form, and Zod.
- RHIE FHIR R4 Client Registry and SHR endpoints with Basic authentication.
- Correct system time, TLS/approved tunnel, database migrations, and a continuously running worker process.

Redis is used elsewhere in CareLogic but is not the HIE outbox durability store; PostgreSQL is.

### 10.2 Backend environment variables

```dotenv
HIE_DEPLOYMENT_ENVIRONMENT="TEST"
HIE_ENDPOINT_ENVIRONMENT="TEST"
HIE_CREDENTIAL_ENVIRONMENT="TEST"
HIE_CLIENT_REGISTRY_BASE_URL="https://.../clientregistry/"
HIE_SHR_BASE_URL="https://.../shr/"
HIE_BASIC_AUTH_USERNAME="..."
HIE_BASIC_AUTH_PASSWORD="..."
HIE_DATA_ENCRYPTION_KEY="<32 bytes, hex or base64>"
HIE_IDENTIFIER_HASH_KEY="<different stable 32 bytes, hex or base64>"
HIE_REQUEST_TIMEOUT_MS=8000
HIE_GET_MAX_ATTEMPTS=3
HIE_GET_RETRY_BASE_MS=250
HIE_ALERT_STALE_MINUTES=30
HIE_ALLOW_INSECURE_TEST=false
```

The documented MoH test IP uses plain HTTP. It is permitted only with all three environment labels set to `TEST`, tenant environment `TEST`, `HIE_ALLOW_INSECURE_TEST=true`, an approved isolated test connection, and synthetic data. Never use that override for real patients.

## 11. Functional test runbook

### 11.1 Prepare a safe test environment

1. Use a dedicated PostgreSQL test database and synthetic patients only.
2. Check out/preserve both backend and frontend HIE work; note the frontend working-tree warning above.
3. Configure the HIE variables with TEST credentials and two independent 32-byte keys.
4. Apply migrations, generate Prisma, and start backend/frontend:

   ```bash
   cd eclinic-backend
   bunx prisma migrate deploy
   bun run db:generate
   bun run dev

   cd ../eclinic-frontend
   npm run dev
   ```

5. Confirm `GET /health` succeeds and authenticate as a platform admin, clinic admin, doctor, nurse/reception user, and a disallowed role for negative RBAC checks.

### 11.2 Enable exactly one pilot clinic

1. As platform admin, add a clinic-scoped entitlement override for `hie`; confirm HIE routes return `FEATURE_DISABLED` before the override.
2. As clinic admin, open Dashboard **Setup → Rwanda HIE**.
3. Save environment `TEST`, enabled `true`, and only `clientRegistry` initially.
4. Confirm `/hie/status` shows TEST and no secrets.
5. Try saving PRODUCTION against TEST deployment variables; expect `HIE_ENVIRONMENT_MISMATCH`.
6. In a safe local test only, try an HTTP URL without the test override; expect secure-transport rejection. Confirm PRODUCTION rejects HTTP even when the override is true.

### 11.3 Verify mappings and terminology

1. Map the pilot branch to a synthetic FOSA and `Location/...` reference with verification evidence and a future review date.
2. Map the test doctor to a synthetic `Practitioner/...` reference.
3. Add a verified destination facility different from the source.
4. As platform admin, create/verify representative concepts and product codes for ICD-11, LOINC, SNOMED CT, ICHI, medication route/method, vaccine/allergy/imaging domains.
5. Confirm a clinic user can list only active verified HIE concepts but cannot perform global verification.
6. Expire or revoke a mapping and confirm readiness/alerts and publication blocking reflect it.

### 11.4 Test national identity

1. At reception, enter a known synthetic NID and exact DOB. Expect a national match and local candidate list.
2. Review the demographic comparison. Link to an existing synthetic local patient using the current `updatedAt`; confirm `VERIFIED` identity and no automatic demographic overwrite.
3. Repeat with a stale `expectedUpdatedAt`; expect a changed-patient conflict.
4. Try the same NID/UPID against another local patient; expect an identity reconciliation case, no merge, and no duplicate verified identity.
5. Exercise unknown NID, DOB mismatch, deceased patient, malformed 200 response, 401, 429, timeout, and registry outage.
6. During outage choose defer; confirm local check-in continues and a pending identity has encrypted snapshot/retry metadata.
7. Restore the registry and wait one minute or use authorized manual retry; expect verification and release of only patient-dependency-blocked events.

### 11.5 Test consent

1. Enable `consentSync` and `sharedRecordWrite` after identity verification.
2. Record written/verbal/electronic evidence with affirmative confirmation. Expect active local consent and a pending Consent outbox event.
3. Run/wait for the worker. Expect Consent `SUCCEEDED`, sync `SYNCED`, resource link populated, and an attempt record.
4. Withdraw consent. Confirm it is immediately inactive locally and a remote delete is queued.
5. Simulate RHIE 404 for delete; expect idempotent success.
6. Finalize a second visit while consent is absent/unsynchronized; local finalization must succeed and clinical events must be `BLOCKED`, not lost.
7. Restore/reconcile consent and confirm eligible events resume.

### 11.6 Test national read and reconciliation

1. Enable `sharedRecordRead` and `nationalListRead`.
2. Open a linked patient chart and the **National record** tab.
3. Verify the IPS and sectioned history display provenance and omit raw patient/resource identifiers.
4. Fail one SHR section while others succeed; expect a partial response and usable successful sections.
5. Accept one item as history and dismiss another with notes. Confirm `HieReconciliation` rows but no local order/diagnosis/payment creation.
6. Replay an expired or another-patient reconciliation token; expect rejection.

### 11.7 Test emergency access

1. Enable `emergencyRead` and use a linked synthetic patient without ordinary read consent.
2. As a doctor, enter reason/justification and request time-bounded access; expect audited read-only data.
3. Attempt as a user without `emergencyHieRead`; expect 403.
4. As clinic admin, review it as approved/concerned with a note; confirm operations pending-review count changes.
5. Confirm expired emergency access no longer authorizes retrieval and never authorizes writes.

### 11.8 Test finalized clinical publication

1. Use a verified patient, synchronized consent, verified branch/doctor, and verified codes.
2. Complete triage with numeric vitals; create a coded diagnosis, lab request/result, structured prescription, dispense, procedure, ward observation/administration, and finalized visit as applicable.
3. Confirm local finalization succeeds and outbox order starts with Encounter (10), then dependent resources.
4. Run/wait for the worker and verify `SUCCEEDED`, `HieSyncAttempt`, and `HieResourceLink` rows.
5. Trigger enqueue again; verify no duplicate business event/resource publication.
6. Remove the ICD-11 code or set terminology to draft; confirm Condition is blocked and free text is not sent.
7. Remove structured medication route/dose/frequency/duration/method or Coverage; confirm the specific actionable dependency reason.
8. Simulate 429/5xx/network failure. GETs may retry in-client; POSTs must make one transport attempt and move through durable retry intervals of 1 minute, 5 minutes, 30 minutes, 2 hours, 12 hours, then daily, dead-lettering after eight failures.
9. Simulate a missing Encounter enqueue, wait past five minutes, and confirm the recovery scan recreates it.

### 11.9 Test structured clinical records and imaging

1. From the patient chart create a draft consultation observation, allergy, immunization, imaging order, and study using verified concepts.
2. Confirm drafts do not publish.
3. Finalize each and verify capability-specific outbox resources and audit events.
4. Try an unverified/inactive concept; expect rejection/blocking.
5. Correct an allergy/immunization; verify original `CORRECTED`, replacement record, and explicit publication semantics.
6. Enter invalid/missing DICOM UID, modality, date, series, or instance metadata; expect validation failure.
7. Confirm no DICOM binary is stored or transmitted.

### 11.10 Test discharge and transfer

1. Discharge an inpatient synthetic visit with a discharge summary. Confirm local discharge commits and Discharge IPS is queued after the Encounter dependency.
2. As doctor, create a transfer from a finalized visit to a verified, different destination.
3. Attempt with non-doctor, unfinalized visit, unverified source/destination, or same source/destination; expect the documented errors.
4. Queue the transfer twice concurrently; one caller should claim it and only one pair of events should exist.
5. Confirm Transfer Encounter and Transfer IPS are separate and idempotent.
6. Cancel a draft/queued transfer; confirm pending events block. Attempt cancellation while processing; expect conflict.
7. Refresh inbound transfers for the patient; only `TRANSFER_ENCOUNTER` resources should import. Move one through reviewed/acknowledged/completed and confirm these are local states.

### 11.11 Test operations and tenant isolation

1. Create success, retry, blocked, stale, and dead-letter data for two clinics.
2. As clinic A, confirm status/outbox/metrics/audit/identity/transfer/governance results never include clinic B.
3. Retry an allowed failed event and confirm status/lock/next-attempt reset.
4. Confirm a disallowed role receives 403 for processing, consent, transfer, emergency, allergy, immunization, and imaging mutations as applicable.
5. Verify alert logs contain only redacted code/count/severity and no identifiers or payload.

### 11.12 Automated verification recorded for this snapshot

The following command passed on 2026-08-12:

```bash
cd eclinic-backend
bun test src/services/hie/__tests__ src/api/v1/hie/__tests__
```

Result: **97 passed, 0 failed, 207 assertions, 9 files**.

Frontend validation also passed:

```bash
cd eclinic-frontend
npm run typecheck
```

Backend `bun run typecheck` and `bun run typecheck:test` did not report source diagnostics; both eventually crashed TypeScript 5.9.2 under Node 20.10.0 with `RangeError: Map maximum size exceeded` in `checkTypeRelatedTo`. Treat backend typechecking as an unresolved tooling/aggregate-type-complexity issue. Reproduce under the deployment-supported Node runtime, isolate large Hono/Prisma inferred types, and add a reliable CI typecheck before production approval.

## 12. Edge cases, limitations, and follow-up work

### 12.1 Intentional functional boundaries

- National `POST /Patient` is externally blocked until MoH defines UPID allocation and duplicate resolution.
- Non-FHIR NIDA `getCitizen` operations are not used.
- External demographics never silently overwrite local demographics and identities never auto-merge.
- National data is read-only provenance unless a clinician records a reconciliation decision; even acceptance does not create local clinical/billing data.
- Transfer acknowledgement is local because the pinned Swagger provides no remote acknowledgement mutation.
- Imaging is metadata-only; PACS/DICOM storage and binary exchange are out of scope.
- General delete/correction of published clinical resources remains gated to explicit audited workflows and MoH-approved semantics.

### 12.2 Operational and technical limitations

- Production endpoints, identifier systems/profiles, auth, rate limits, error/idempotency behavior, FOSA/Practitioner/Coverage verification sources, consent policy, and UPID workflow still require authoritative MoH confirmation.
- The test server value embedded in Swagger is intentionally not trusted; deployment URLs are explicit environment configuration.
- The circuit breaker is in process, not shared across replicas.
- Scheduler execution is embedded in the API process. Confirm multi-replica worker ownership/claim behavior or move jobs to a dedicated worker.
- The response limit is fixed at 2 MiB; a larger legitimate Bundle is rejected rather than paginated. Confirm RHIE paging requirements.
- National section retrieval uses up to four concurrent requests and currently depends on the pinned list operations; validate external rate-limit compatibility.
- HIE encryption has a versioned envelope but no implemented online key-rotation/re-encryption procedure. Define and rehearse one before rotation.
- Changing the identifier HMAC key breaks indexed equality. Back it up separately and define disaster recovery.
- Mapping verification can be manually attested. Production should use authoritative registry contracts, review expiry, and separation of duties.
- Backend aggregate typecheck currently exhausts the TypeScript relation cache; fix/contain this and enforce in CI.
- Frontend HIE work is uncommitted at this snapshot and could be lost or omitted from deployment.

### 12.3 Production readiness work

Before enabling real patients:

1. Obtain MoH approval/confirmation for production endpoints, profiles, identifier systems, credentials, consent, rate limits, error/idempotency semantics, UPID, facility/practitioner registries, paging, and correction/delete rules.
2. Complete DPIA/privacy review, data-retention rules, incident response, breach notification, access review, and break-glass review ownership.
3. Provision secrets in a secret manager; establish credential/encryption rotation and recovery procedures.
4. Use TLS or an approved secure tunnel; never production-enable the HTTP test override.
5. Resolve backend typecheck reliability and add frontend/backend HIE tests to CI.
6. Commit the frontend implementation and verify the exact deployment commit pair.
7. Load/concurrency-test outbox claiming, worker recovery, circuit behavior, national record reads, and multi-tenant isolation.
8. Establish dashboards/alert delivery/SLOs and an on-call runbook; current monitoring primarily logs redacted alerts.
9. Perform synthetic TEST conformance and user acceptance, then a one-clinic/one-branch controlled pilot with rollback rehearsal.
10. Reconcile the pinned contract whenever RHIE Swagger changes; update `RHIE_CONFORMANCE_MATRIX.md`, endpoint registry, schemas, tests, and this guide together.

## 13. Troubleshooting quick reference

| Symptom | Most likely checks |
| --- | --- |
| HIE UI absent / route 403 `FEATURE_DISABLED` | Clinic entitlement override; authenticated tenant; frontend permission matrix |
| Status says not configured | Environment labels, both URLs, credentials, both encryption keys |
| Secure transport error | HTTPS/tunnel; TEST-only override; never bypass in production |
| Identity lookup returns no match | Exact normalized 16-digit NID, date-only DOB, registry response contract, deceased flag |
| Identity conflict | Existing NID/UPID hash; open `HieIdentityReconciliation`; never manually delete without reviewed resolution |
| Clinical event `BLOCKED` | Inspect `dependencyReason`: identity, synchronized consent, mapping, encounter, terminology, Coverage, or structured dosage |
| Repeated `RETRY` / dead letter | RHIE status/rate limit/network, attempt history, correlation ID; fix cause then authorized retry |
| National record partially unavailable | Per-section safe error/retryable flag; circuit state; response size; external list endpoint |
| Transfer cannot queue | Doctor role, finalized visit, branch, verified source/destination, distinct destination, current status |
| Consent withdrawal appears pending | Locally inactive is expected; inspect delete outbox, remote ID, and idempotent 404 behavior |
| Backend typecheck crashes | Reproduce Node/TS version; isolate aggregate Hono/Prisma types; do not interpret as a passing typecheck |

## 14. Reference artifacts

- `docs/RWANDA_HIE.md`: concise deployment and safety overview.
- `docs/RHIE_CONFORMANCE_MATRIX.md`: endpoint-by-endpoint pinned-contract status and gates.
- `docs/rhie-swagger-2026-08-11.yaml`: immutable external contract snapshot used for implementation decisions.
- `src/services/hie/__tests__/` and `src/api/v1/hie/__tests__/`: executable transport, mapping, safety, recovery, permission, identity, and concurrency examples.

When behavior and this guide diverge, verify the deployed commit first, then use routes/controllers/services/schema/tests as runtime truth and update this guide in the same change.
