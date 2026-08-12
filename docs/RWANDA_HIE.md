# Rwanda HIE integration

CareLogic connects to Rwanda's HIE through the backend only. The code-ready
surface includes national identity lookup/linking, synchronized consent,
comprehensive read-only national records, finalized clinical publication,
structured allergy and immunization records, imaging metadata, emergency-read
governance, and distinct inter-facility transfers. Every high-risk capability
is tenant controlled and disabled by default.

## Safety boundaries

- HIE credentials and encryption keys belong in the deployment secret manager.
  They must never be set in the frontend or use a `NEXT_PUBLIC_` name.
- Production rejects a plain-HTTP HIE URL. The supplied test IP can only be used
  outside production when `HIE_ALLOW_INSECURE_TEST=true` and the deployment is
  approved for synthetic data.
- Local registration and clinical care continue when HIE is unavailable.
- National demographic differences require human review. Linking does not
  overwrite local demographics or silently merge patients.
- External records are retrieved on demand, converted server-side to a minimal
  provenance view, and are not converted into local orders, diagnoses,
  prescriptions, or billing events. Raw FHIR and national resource identifiers
  are not sent to the browser; reconciliation uses a short-lived opaque token.
- No `Patient` creation call is implemented until MoH documents UPID allocation
  and duplicate-resolution behavior.

## Configuration

Configure the backend variables documented in `.env.example`. Use distinct URLs
for the Client Registry and Shared Health Record even if the test environment
temporarily exposes both on the same host. The default request timeout is eight
seconds and the maximum accepted response is two MiB. Safe GET requests retry
transient network, 429, and 5xx failures up to `HIE_GET_MAX_ATTEMPTS` with
bounded exponential backoff. POST requests are never transport-retried by the
client; durable outbox idempotency governs publication retries.
Keep the identifier HMAC key separate and stable across application encryption
key rotations, because it enforces NID/UPID uniqueness without storing plaintext.

For the supplied MoH test environment, configure
`HIE_CLIENT_REGISTRY_BASE_URL=http://197.243.24.138:5001/clientregistry/` and
`HIE_SHR_BASE_URL=http://197.243.24.138:5001/shr/`, set
`HIE_DEPLOYMENT_ENVIRONMENT=TEST`, `HIE_ENDPOINT_ENVIRONMENT=TEST`, and
`HIE_CREDENTIAL_ENVIRONMENT=TEST`, and set `HIE_ALLOW_INSECURE_TEST=true`. Use
only synthetic identities over that plain-HTTP connection. The Swagger's
embedded server value is deliberately not used by the code.

Every request requires the tenant, deployment, endpoint, and credential
environments to match. A test-labelled tenant cannot use production endpoints
or credentials, and a production-labelled tenant cannot use test endpoints or
credentials. Production always rejects plain HTTP.

The HIE entitlement defaults to disabled for all plans. An administrator must:

1. enable the `hie` entitlement for the pilot clinic;
2. save a tenant configuration with only the approved capabilities enabled;
3. map every publishing branch to a verified FOSA/location identifier;
4. map publishing clinicians to verified national Practitioner identifiers;
5. record an active patient sharing consent; and
6. activate the clinic only after test-environment acceptance.

Missing mappings or consent block only the corresponding HIE event. They do not
roll back or fail the local clinical event.

## API surface

All routes are under `/api/v1/hie` and are tenant scoped.

- `GET /status`: capability and mapping health without secrets.
- `PUT /config`: clinic capability activation.
- `PUT /facilities`: verified branch/FOSA mapping.
- `PUT /practitioners`: verified user/Practitioner mapping.
- `POST /patients/lookup`: NID and birth-date Client Registry lookup.
- `POST /patients/link`: reviewed NID/UPID link with optimistic concurrency.
- `POST /patients/defer-verification`: record an offline/deferred outcome.
- `GET /patients/:patientId/ips`: on-demand national record retrieval.
- `GET /patients/:patientId/national-record`: sectioned national record with
  independent partial-failure metadata.
- `POST /consents` and `POST /consents/:id/withdraw`: sharing consent lifecycle.
- `POST /patients/:patientId/consent/reconcile`: reconcile national consent.
- `POST /patients/:patientId/emergency-access` and
  `POST /emergency-access/:id/review`: time-bounded read-only break glass.
- Structured consultation observation, allergy, immunization, imaging order,
  and imaging-study APIs use dedicated permissions and capability gates.
- Super-admin clinical-concept APIs govern national codes; clinic users cannot
  verify or alter global terminology.
- Coverage mapping and DOB discrepancy APIs provide audited remediation.
- `GET /national-audit`: validated, tenant-scoped national AuditEvent reads.
- `POST /reconciliations`: clinician review of an external item.
- `GET /outbox` and `POST /outbox/:id/retry`: administrator operations.
- `GET /operations/summary`: tenant-scoped publication status, resource volume,
  latency, retry age, facility readiness, and operational alerts.
- `GET|POST /transfers`, `POST /transfers/:id/queue`, and
  `POST /transfers/:id/cancel`: external transfers, separate from bed moves and
  clinician handoffs.

The worker processes the durable outbox every minute. Retry delays are one
minute, five minutes, thirty minutes, two hours, twelve hours, and then daily.
Events dead-letter after eight failed attempts. Authorization headers,
identifiers, and FHIR payloads are excluded from application logs.
Blocked dependencies are automatically reconsidered when their scheduled retry
time arrives, up to the same eight-attempt bound. A five-minute monitor emits
redacted operational alerts for dead letters, stale work, degraded health,
unverified publishing facilities, and elevated failure rates. Configure stale
age with `HIE_ALERT_STALE_MINUTES`.

Finalized visits publish in dependency order. The Encounter is first, followed
by ICD-11-coded visit diagnoses. Uncoded diagnoses remain `BLOCKED` with an
actionable terminology reason; free text is never substituted for ICD-11.

## Deployment order

Run the Prisma migration before enabling any tenant. Start with synthetic data
in the test environment, one clinic, and one branch. Validate found/not-found,
DOB mismatch, 401, 429, timeout, malformed response, duplicate identity,
consent withdrawal, retries, and IPS provenance before activating real patients.

Production activation requires MoH confirmation of the production endpoints,
FHIR profiles, identifier systems, FOSA and Practitioner identifiers, consent
rules, rate limits, idempotency behavior, error contract, UPID workflow, and
secure connectivity. It also requires the approved DPIA, incident runbook,
credential rotation, monitoring, access review, and rollback rehearsal.

The pinned contract and endpoint-by-endpoint implementation status are recorded
in `docs/RHIE_CONFORMANCE_MATRIX.md`. Code readiness is not production approval.
