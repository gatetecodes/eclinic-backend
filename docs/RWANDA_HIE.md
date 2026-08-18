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
  and duplicate-resolution behavior. UPID *resolution* through `getCitizen` is
  implemented and is read-only: it returns an identifier for human review and
  never creates, links, or mutates a local identity on its own.

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
`HIE_CLIENT_REGISTRY_BASE_URL=http://197.243.24.138:5001/clientregistry/`,
`HIE_SHR_BASE_URL=http://197.243.24.138:5001/shr/`, and
`HIE_CITIZEN_BASE_URL=http://197.243.24.138:5001/api/v1/citizens/`, set
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
- `PUT /facilities`: branch/FOSA mapping with a manual attestation.
- `PUT /practitioners`: user/Practitioner mapping with a manual attestation.
- `GET /registry/facilities`: searches the national Facility Registry snapshot to
  feed the mapping picker. Returns a `mode` of `REGISTRY`, `DIRECTORY_EMPTY` or
  `MANUAL_ONLY` rather than an error, so the console degrades to manual
  attestation instead of showing a failure.
- `POST /registry/facilities/sync`: forces a directory refresh (`process`).
- `POST /facilities/verify`, `POST /destinations/verify`,
  `POST /practitioners/verify`: grants `VERIFIED` from a registry match.
  `VERIFIED` is deliberately absent from every request schema — it is only ever
  computed server-side from a registry match, so the status cannot be asserted by
  a client. A mismatch returns 409 with the registry's own view in `issues`, and
  a mapping that was already usable (`VERIFIED` or `MANUAL_ATTESTED`) records the
  failed check without being downgraded, because `CONFLICT` blocks publication.

### Assurance levels

`VERIFIED` means the backend matched the mapping against the national registry
snapshot for the clinic's own environment; it expires after
`HIE_REGISTRY_VERIFICATION_TTL_DAYS` (90 by default) because registry facts drift.
`MANUAL_ATTESTED` means a clinic administrator recorded their own evidence. Both
satisfy every gate — publication, UPID resolution and transfers — so a clinic in a
district whose registry is unreachable is never locked out. Requiring `VERIFIED`
alone previously made UPID resolution and transfer creation unreachable, since no
endpoint could write that status.

The Provider Registry ships with `HIE_PROVIDER_REGISTRY_BASE_URL` unset: the MoH
collection publishes it only on a direct host behind an `x-auth-token` JWT, and
this client speaks HTTP basic auth through openHIM. Practitioner verification
therefore returns 503 `HIE_PROVIDER_REGISTRY_NOT_CONFIGURED` until MoH confirms a
gateway route; manual attestation is unaffected.
- `POST /patients/lookup`: NID and birth-date Client Registry lookup.
- `POST /patients/request-upid`: NIDA-backed UPID resolution for a patient the
  Client Registry has no `Patient` for. Attributed to the branch's verified FOSA
  code, audited, and minimized to the fields needed to confirm identity. The
  receptionist takes the resolved UPID back through lookup and link, so national
  demographics never silently overwrite or merge a local patient.
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
  clinician handoffs. Transfers optionally capture transfer/transport type,
  ambulance call and departure times, receiving clinician contact, and caregiver
  details, published as the MoH transfer Encounter extensions. All are optional
  so an emergency transfer is never blocked on paperwork.

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

## Terminology

Every published `system` URI is defined once, in
`src/services/hie/terminology.ts`. Mappers must not inline a system as a string
literal — that is how `Condition.code` previously drifted onto a non-canonical
ICD-11 URI. `src/services/hie/__tests__/conformance-payloads.test.ts` pins the
priority flows against the MoH reference payloads, so a coding change fails in
CI rather than at the MoH.

Diagnoses and medications are dual coded. `Condition.code` carries ICD-11
(`http://id.who.int/icd/release/11/mms`) plus SNOMED CT when
`VisitDiagnosis.snomedCode` is mapped; the medication resources carry SNOMED CT
plus RxNorm when `Product.rxNormCode` is mapped. Dual coding is additive: the
first coding is the one that gates publication, so an unmapped second code
reduces payload richness without ever blocking a publication that would
otherwise succeed.

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
