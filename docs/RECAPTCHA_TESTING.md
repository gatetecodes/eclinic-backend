# Testing reCAPTCHA v3 Implementation

This guide covers how to test the reCAPTCHA v3 protection on public forms (eclinic + queueless).

## 1. Prerequisites

- **Backend** (`eclinic-backend`): `.env` has `RECAPTCHA_ECLINIC_SECRET` set (and optionally `RECAPTCHA_ENABLED`).
- **eclinic-frontend**: `.env.local` has `NEXT_PUBLIC_RECAPTCHA_SITE_KEY_ECLINIC`.
- **queueless-frontend**: `.env` has `NEXT_PUBLIC_RECAPTCHA_SITE_KEY_QUEUELLESS`.
- Site key and secret must be a **pair** from the same reCAPTCHA v3 site in [Google reCAPTCHA Admin](https://www.google.com/recaptcha/admin).

## 2. Disable reCAPTCHA Locally (Optional)

To test flows without tokens (e.g. other features), disable verification:

In **eclinic-backend** `.env`:

```env
RECAPTCHA_ENABLED=false
```

Restart the backend. Protected routes will skip token checks and accept requests without `x-recaptcha-token`.

Set `RECAPTCHA_ENABLED=true` or remove the variable to turn verification back on.

## 3. Manual Testing With reCAPTCHA On

### 3.1 Happy path (real token)

1. Start backend and frontend(s):
   - `eclinic-backend`: e.g. `npm run dev` (port 4002).
   - `eclinic-frontend`: e.g. `npm run dev` (port 3000).
   - `queueless-frontend`: e.g. `npm run dev` (if testing queueless).
2. Ensure `RECAPTCHA_ENABLED` is not `"false"` in backend `.env`.
3. Open the form in the browser and submit with valid data:
   - **eclinic**: Demo request (marketing contact), Patient portal book appointment.
   - **queueless**: Register, Join queue (QR page).
4. You should see a successful response (e.g. demo submitted, appointment booked, queue joined). No visible reCAPTCHA challenge (v3 is invisible).

### 3.2 Missing token (backend rejects)

Use curl or Postman to call a protected endpoint **without** `x-recaptcha-token`:

```bash
curl -X POST http://localhost:4002/api/v1/demo-requests \
  -H "Content-Type: application/json" \
  -d '{"clinic_name":"Test","email":"a@b.com","phone_number":"+250788000000","address":"Kigali","demo_date":"2025-06-01T10:00:00.000Z"}'
```

Expected: **400** with body like:

```json
{
  "success": false,
  "status": 400,
  "error": {
    "code": "RECAPTCHA_MISSING_TOKEN",
    "message": "Missing reCAPTCHA token."
  }
}
```

### 3.3 Invalid or reused token (backend rejects)

Send a fake or expired token:

```bash
curl -X POST http://localhost:4002/api/v1/demo-requests \
  -H "Content-Type: application/json" \
  -H "x-recaptcha-token: invalid-token" \
  -d '{"clinic_name":"Test","email":"a@b.com","phone_number":"+250788000000","address":"Kigali","demo_date":"2025-06-01T10:00:00.000Z"}'
```

Expected: **403** with body like:

```json
{
  "success": false,
  "status": 403,
  "error": {
    "code": "RECAPTCHA_VERIFICATION_FAILED",
    "message": "Failed reCAPTCHA verification.",
    "details": ["..."]
  }
}
```

### 3.4 Wrong action (backend rejects)

If your backend checks `expectedAction`, a token from a different action (e.g. from another form) can return **403** with `code: "RECAPTCHA_UNEXPECTED_ACTION"`. Use the correct form/action when testing success.

## 4. Google reCAPTCHA Test Keys (Optional)

For automated or repeatable tests, you can use [Google’s test keys](https://developers.google.com/recaptcha/docs/faq#id-like-to-run-automated-tests-with-recaptcha.-what-should-i-do):

- **Site key (v3):** `6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI`
- **Secret key (v3):** `6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe`

With test keys:

- Any token you send will verify as **success** and return a **score of 0.9**.
- You can test “valid token” flows without real user interaction.
- Use these only in test/local environments, not production.

## 5. Protected Endpoints Reference

| App        | Endpoint                               | Action name               |
|-----------|----------------------------------------|---------------------------|
| eclinic   | POST /api/v1/demo-requests             | eclinic_demo_request      |
| eclinic   | POST /api/v1/patient-portal/appointments | eclinic_patient_booking |
| queueless | POST /api/v1/onboarding/register-queueless | queueless_register     |
| queueless | POST /api/v1/public/queues/:id/join    | queueless_queue_join      |
| queueless | POST /api/v1/public/queues/patients/check | queueless_patient_check |

## 6. Troubleshooting

- **"Missing reCAPTCHA site key" in browser:** Set `NEXT_PUBLIC_RECAPTCHA_SITE_KEY_ECLINIC` (eclinic) or `NEXT_PUBLIC_RECAPTCHA_SITE_KEY_QUEUELLESS` (queueless) in the frontend env and restart the dev server.
- **403 RECAPTCHA_VERIFICATION_FAILED:** Token invalid, expired, or wrong secret. Ensure backend secret matches the site key’s secret in reCAPTCHA Admin.
- **403 RECAPTCHA_LOW_SCORE:** Google returned a score below your threshold (default 0.5). In production you can log the score and tune the threshold; locally you can use test keys (score 0.9) or temporarily set `RECAPTCHA_ENABLED=false`.
- **403 RECAPTCHA_UNEXPECTED_ACTION:** Token was generated with a different `action` (e.g. wrong form). Call `executeRecaptcha('<action>')` with the action name expected by the route (see table above).
