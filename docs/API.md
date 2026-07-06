# BFF API reference

The HTTP contract of `apps/api` (the BFF). Product apps never call these routes by hand — they
go through `@medibun/api-client`, which is the typed, tested mirror of this document. When the
two disagree, the api-client contract tests are the arbiter; fix the drift in the same PR.

Base URL in local dev: `http://localhost:3001`. The portal reaches it via its own same-origin
`/api` proxy (Next rewrite) so the session cookie stays first-party.

## Conventions

- **Auth**: an opaque session id, sent either as the `medibun_session` HttpOnly cookie (web) or
  as `Authorization: Bearer <token>` (mobile). Bearer wins when both are present. Sessions are
  minted by `POST /auth/login` (docs/AUTH.md has the design).
- **CSRF/origin guard**: every mutating (non-GET) request that carries a browser `Origin` header
  must match `API_ALLOWED_ORIGINS` exactly, or it's rejected `403 forbidden_origin` — fail-closed
  and registered globally, so future mutating routes are covered the day they land. Origin-less
  requests (curl, mobile, server-to-server) pass; the cookie isn't attached there anyway.
- **Errors**: every client-facing error body is exactly `{ "error": <code>, "requestId": <id> }` —
  a generic code plus a correlation id, **never a message and never PHI**. Request logs carry
  identifiers only (id, method, path, status, duration); never query strings, bodies, or headers.
- **Request id**: honored from `x-request-id` or generated; always echoed back in the
  `x-request-id` response header. Quote it when reporting a problem.

### Error codes

`internal_error` · `not_found` · `invalid_request` · `rate_limited` · `invalid_credentials` ·
`mfa_not_supported` · `membership_selection_not_supported` · `forbidden_origin` ·
`unauthorized` · `forbidden` · `slot_taken` · `conflict`

## Health

| Route                 | Auth | Returns                                                  |
| --------------------- | ---- | -------------------------------------------------------- |
| `GET /health`         | none | `{ "status": "ok" }`                                     |
| `GET /health/medplum` | none | `{ "connected": true }`, or `503 { "connected": false }` |

## Auth

### `POST /auth/login`

Body `{ "email": string, "password": string }`. Brokers a Medplum direct login server-side and
mints a session. Success: `200 { "sessionToken": <opaque id> }` **and** the `medibun_session`
HttpOnly cookie (SameSite=Lax; Secure outside local-http dev). Web clients use the cookie;
mobile keeps the token for bearer auth.

Failures: `400 invalid_request` (missing fields) · `429 rate_limited` (per-IP window) ·
`401 invalid_credentials` · `501 mfa_not_supported` / `501 membership_selection_not_supported`
(recognized Medplum login branches that are their own future PRs).

### `POST /auth/logout`

Session from cookie or bearer. Always clears the cookie and returns `200 { "ok": true }` —
upstream Medplum Login revocation is best-effort by design (docs/AUTH.md), and a failure there
must not strand the user in a logged-in UI.

## Patient

### `GET /patients/me`

The signed-in patient's own profile, read **as that user** (their Medplum token, their
compartment, their audit attribution). Returns a `PatientProfile`:

```json
{ "id": "…", "name": "Synthia Loginsmith", "birthDate": "1990-01-01" }
```

`401 unauthorized` (no/expired session) · `404 not_found` (valid session, no resolvable patient
profile — e.g. a future staff session). The api-client folds both into `undefined`: benign
signed-out-equivalent states, never crashes.

## Booking (S4)

Session-gated. Scheduling calls run under the BFF's service client with the patient bound from
the session — the principal decision is recorded in `docs/DATA_MODEL.md` ("book via BFF") and
`apps/api/src/booking.ts`. The service menu and availability are PHI-free.

### `GET /services`

`200 { "services": ServiceSummary[] }` — the active menu from the experience-DB catalog
(rows without a FHIR HealthcareService link are hidden):

```json
{
  "code": "svc-botox",
  "name": "Botox",
  "description": "…",
  "durationMinutes": 30,
  "priceCents": 36000,
  "categoryColor": "moss"
}
```

`401 unauthorized`.

### `GET /services/:code/availability`

Open times per practitioner over the booking window (7 days, BFF-owned), via Medplum `$find`
per schedule. Returns a `ServiceAvailability` — note the DTO **carries the window and the
practice timezone**, so clients render exactly this window and never mint their own clock:

```json
{
  "serviceCode": "svc-botox",
  "timezone": "America/New_York",
  "windowStart": "2026-07-04T14:00:00.000Z",
  "windowDays": 7,
  "practitioners": [
    {
      "scheduleId": "…",
      "practitionerId": "…",
      "practitionerName": "Dana Cho, RN",
      "slots": [{ "start": "…", "end": "…" }]
    }
  ]
}
```

`401 unauthorized` · `404 not_found` (unknown service code).

### `POST /appointments`

Body `{ "serviceCode": string, "scheduleId": string, "start": string }` — a slot exactly as
returned by availability. The BFF re-derives the schedule and computes `end` server-side, then
books via Medplum `$book` (serializable transaction — double-booking loses with a 409). Patients
book for themselves only; the patient reference comes from the session, never the body.

Success: `201` with a `BookedAppointment`:

```json
{
  "id": "…",
  "serviceCode": "svc-botox",
  "serviceName": "Botox",
  "practitionerName": "Dana Cho, RN",
  "start": "…",
  "end": "…"
}
```

`401 unauthorized` · `403 forbidden` (non-patient principal — staff booking arrives with S11) ·
`400 invalid_request` (missing/malformed fields, unknown service/schedule, invalid or past
start) · `409 slot_taken` (the window was booked in the meantime — clients re-pick calmly).

## Staff (S5)

Session-gated, and — unlike booking — **every FHIR call runs as the signed-in staff member's
own Medplum principal** (their session token). Their org-parameterized AccessPolicy
(`staff-front-desk-v1` / `staff-clinician-v1`, A3) is the enforcement line, and AuditEvents
attribute to them by construction. `GET /staff/schedule` and the status route additionally require
a `Practitioner/` profile: a signed-in patient gets `403 forbidden`. Encounter creation on
check-in belongs to the check-in Bot (A7), never these routes.

### `GET /staff/me`

The signed-in staff member's own profile. `200 { "id": "…", "name": "Noor Haddad" }` ·
`401 unauthorized` · `404 not_found` (valid session, non-staff principal). The api-client folds
both into `undefined`.

### `GET /staff/schedule`

The schedule sheet for a practice-local range: `?date=YYYY-MM-DD` (range start; a real
calendar date — anything else is `400 invalid_request`; omitted = today) and `?days=1|7`
(1 = day view, 7 = week view; anything else is `400`; omitted = 1). The window is resolved
in the practice timezone, DST-safe per day. Calendar navigation state, not PHI — the only
query parameters this surface carries. A month range is a future slice
(`docs/SCHEDULE_DESIGN.md`). Returns a `DaySheet`:

```json
{
  "date": "2026-07-04",
  "days": 1,
  "timezone": "America/New_York",
  "practitioners": [{ "practitionerId": "…", "practitionerName": "Riley Reyes" }],
  "appointments": [
    {
      "id": "…",
      "practitionerId": "…",
      "patientId": "…",
      "patientName": "Synthia Loginsmith",
      "patientPhone": "555-010-0100",
      "patientEmail": "…",
      "serviceCode": "svc-botox",
      "serviceName": "Botox",
      "serviceColor": "sage",
      "start": "…",
      "end": "…",
      "status": "scheduled",
      "firstVisit": true,
      "bookedAt": "…"
    }
  ]
}
```

`status` is the staff workflow — `scheduled | arrived | roomed | completed | no-show` — mapped
by the BFF to FHIR `Appointment.status` (`booked | arrived | checked-in | fulfilled | noshow`).
Appointments in unmapped FHIR statuses (cancelled, entered-in-error, …) are not day-sheet rows.
Contact/service fields are optional; `firstVisit` means no prior non-cancelled appointment.

`400 invalid_request` (malformed/impossible date, or days ∉ {1,7}) · `401 unauthorized` · `403 forbidden`
(non-staff principal).

### `POST /staff/appointments/:id/status`

Body `{ "status": <workflow status> }`. Moves an appointment through the workflow. The server
validates the transition against the appointment's CURRENT status (each forward step plus its
exact reverse, for the ~10s undo) and writes with an atomic test-and-set — a concurrent move at
another station loses cleanly. Success: `200 { "id": "…", "status": "arrived" }`.

`400 invalid_request` (unknown status value) · `401 unauthorized` · `403 forbidden` (non-staff
principal, or the AccessPolicy refused the write) · `404 not_found` ·
`409 conflict` (illegal transition from the current status, or a lost race — the client
refetches truth and re-decides; never clobbers).

## Change discipline

New endpoints land with: session gating decided explicitly, error codes added to the enum here
and in `@medibun/api-client`, contract tests, an AccessPolicy review if the route touches PHI,
and this file updated in the same PR (definition of done).
