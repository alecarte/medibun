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
(1 = day view, 7 = week view; anything else is `400`; omitted = 1). **Week ranges snap to
Monday**: with `days=7` the BFF aligns the range start to the Monday of the requested
date's week (weeks start Monday, `docs/SCHEDULE_DESIGN.md`), so the returned `date` may
be earlier than the one requested — clients render the returned range, never the request.
The shared `weekStart` helper in `@medibun/api-client` is the single source of that
alignment (BFF and staff app both import it). The window is resolved in the practice
timezone, DST-safe per day. Calendar navigation state, not PHI — the only query
parameters this surface carries. A month range is a future slice
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
  ],
  "events": [
    {
      "id": "…",
      "type": "meeting",
      "title": "Team huddle",
      "practitionerIds": ["…"],
      "start": "…",
      "end": "…"
    }
  ]
}
```

`status` is the staff workflow — `scheduled | arrived | roomed | completed | no-show` — mapped
by the BFF to FHIR `Appointment.status` (`booked | arrived | checked-in | fulfilled | noshow`).
Appointments in unmapped FHIR statuses (cancelled, entered-in-error, …) are not day-sheet rows.
Contact/service fields are optional; `firstVisit` means no prior non-cancelled appointment.

`events` are internal events (S5c): staff meetings and misc time blocks — patient-less
appointments in FHIR (see `docs/DATA_MODEL.md`), partitioned out of `appointments`.
`type ∈ meeting | block`; `title` is optional and **non-PHI by rule** (it renders
unmasked under the staff privacy mask). Time off is not a type — it's a titled block
("PTO"), and an all-day event's window is the full practice-local day (00:00 → next
00:00), which is how clients detect "All day" on read.

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
refetches truth and re-decides; never clobbers). Internal events answer `404` here — they
have no patient workflow.

### `POST /staff/appointments/:id/reschedule`

Drag-to-reschedule (S5.5). Body is practice-local — the BFF owns all timezone math and
preserves the appointment's duration:

```json
{ "date": "2026-07-06", "startTime": "15:15", "practitionerId": "…" }
```

Only **scheduled** appointments move (arrived/roomed patients are in the building;
completed/no-show are history); the target practitioner must have a schedule for the
appointment's service. The BFF re-derives that the target window is free against busy
Slots (never trusts the client), creates the new busy Slot, **re-checks the window with
its claim visible** (two stations racing different appointments onto the same open
window: one loses here — no serializable `$reschedule` exists at our Medplum pin, so the
check-then-act gap is closed to a search round-trip rather than a transaction), patches
the Appointment with **test-and-sets on its current start and versionId** (any concurrent
write loses cleanly and compensates by removing the new slot), then deletes the old slot.
Reads and the Appointment patch run AS THE CALLER; only the Slot swap rides the service
client (S5c's split-principal pattern). Schedule availability _hours_ are deliberately not enforced — an off-hours
squeeze-in is staff judgment; conflicts are what matter. Success:
`200 { "id", "practitionerId", "start", "end" }`.

`400 invalid_request` (malformed date/time, unknown target practitioner, or no service
code on the appointment) · `401 unauthorized` · `403 forbidden` (non-staff principal) ·
`404 not_found` (unknown id — internal events answer this too) · `409 conflict` (target
window taken, appointment not scheduled anymore, or a lost race — refetch and re-decide).

### `POST /staff/appointments/:id/cancel`

Cancels a **scheduled** appointment (S5.7). No `$cancel` exists at our Medplum pin — the
BFF patches `Appointment.status → cancelled` with test-and-sets on the current status
and versionId (a concurrent move loses cleanly), writes the **coded** reason to FHIR
`Appointment.cancelationReason` (our CodeSystem, `docs/DATA_MODEL.md` — coded, never
free text), then deletes the appointment's protector Slot(s), which is exactly what
makes `$find` offer the window again. Status patch runs AS THE CALLER; slot deletes
ride the service client (the S5c/S5.5 split-principal pattern). Body:

```json
{ "reason": "patient" }
```

`reason ∈ patient | practice | no-longer-needed`. Success: `200` with the move-up
match cue — waiting move-up entries the freed window could serve (same service;
the entry's practitioner preference doesn't exclude the freed column; never the
cancelled appointment's own entry). A cue for the desk, not a promise of fit:

```json
{ "id": "…", "status": "cancelled", "moveUpMatches": 2 }
```

`400 invalid_request` (reason outside the coded set) · `401 unauthorized` ·
`403 forbidden` (non-staff principal) · `404 not_found` (unknown id — internal events
answer this too) · `409 conflict` (not scheduled anymore, or a lost race — refetch).

### `POST /staff/appointments/:id/restore`

The ~10s compensating undo of a cancel. Restore re-protects the window FIRST — mint
the busy Slot, re-check the window with the claim visible (the S5.5 pattern; a failed
restore never leaves the window blocked) — then patches `cancelled → booked` and
removes the cancellation reason. Success: `200 { "id": "…", "status": "scheduled" }`.

`401 unauthorized` · `403 forbidden` · `404 not_found` · `409 conflict` (**the freed
window was taken inside the undo period** — surfaced honestly, the appointment stays
cancelled; also: not cancelled anymore, no re-derivable schedule, or a lost race).

### Move-up list (S5.7): `GET|POST /staff/move-up` · `PATCH /staff/move-up/:id`

The desk-worked cancellation-backfill waitlist. Experience data: the
`move_up_requests` table stores **ids only** (patient, appointment, service code,
optional practitioner preference) plus a ≤120-char note that is **non-PHI by rule**
(availability quirks — same rule and UI microcopy as internal-event titles). Names,
phones, and appointment times are resolved live from FHIR **as the caller** on every
read — nothing PHI-shaped enters the experience DB, reads are org-scoped by the
caller's policy and audit-attribute to the real staff user. Fulfilling = rescheduling
the patient's existing appointment earlier (the S5.5 endpoint), then marking the
entry here. Phase-2 seam: a Bot on `Appointment?status=cancelled` works `waiting`
rows automatically.

**`GET /staff/move-up`** — waiting entries, oldest first (fairness). `200`:

```json
{
  "entries": [
    {
      "id": "…",
      "patientId": "…",
      "patientName": "Synthia Loginsmith",
      "patientPhone": "555-010-0100",
      "appointmentId": "…",
      "appointmentStart": "…",
      "serviceCode": "svc-botox",
      "serviceName": "Botox",
      "practitionerId": "…",
      "practitionerName": "Riley Reyes",
      "note": "mornings only",
      "createdAt": "…"
    }
  ]
}
```

`patientPhone`/`appointmentStart`/`serviceName`/practitioner fields are optional —
a since-deleted OR policy-hidden resource degrades that field (name falls back to
"Unknown"), never the whole list: one row the caller's AccessPolicy can't resolve
must not abort the panel or masquerade as a session problem. Only a dead token
(401) fails the request. Absent `practitionerId` = any qualified provider.
`401 unauthorized` · `403 forbidden` (non-staff principal).

**`POST /staff/move-up`** — body
`{ "appointmentId": "…", "practitionerId": "…?", "note": "…?" }`. The BFF reads
the appointment as the caller and derives `patientId`/`serviceCode` server-side —
only a **scheduled** appointment joins. Success: `201` with the resolved entry
(shape above). One waiting entry per appointment (DB partial-unique).

`400 invalid_request` (empty id, unknown practitioner preference, note over 120
chars, or an appointment without our service code) · `401 unauthorized` ·
`403 forbidden` · `404 not_found` (unknown id — internal events too) ·
`409 conflict` (already waiting, or the appointment isn't scheduled anymore).

**`PATCH /staff/move-up/:id`** — body
`{ "status": "fulfilled" | "removed" }`, the two terminal states (fulfilled =
their appointment was rescheduled earlier; removed = withdrawn). Success:
`200 { "id": "…", "status": "fulfilled" }`. Resolved entries leave the list but stay
in the table (`resolvedAt`).

`400 invalid_request` (status outside the pair) · `401 unauthorized` ·
`403 forbidden` · `404 not_found` (unknown, malformed, or already-resolved id —
identical answers).

### `POST /staff/events`

Creates an internal event (S5c): a staff meeting or a misc time block. Time off is a
titled block ("PTO", "Time away") — all-day or partial (half-days), never a category
(amendment, Alec 2026-07-06). Body is **entirely practice-local** — the BFF owns all
wall-time → instant math (DST-safe):

```json
{
  "type": "meeting",
  "title": "Team huddle",
  "practitionerIds": ["…"],
  "date": "2026-07-06",
  "startTime": "12:00",
  "endTime": "12:30"
}
```

`allDay: true` replaces the times and covers the whole practice-local `date`; otherwise
`startTime`/`endTime` are required ("HH:mm" wall times on `date`). `title` (≤ 80 chars,
optional on both types) is **non-PHI by rule**. A block takes exactly one practitioner;
meetings take one or more. In FHIR this creates a patient-less Appointment
plus one `busy-unavailable` Slot per schedule the chosen practitioners own, so `$find`
can't offer the window to patients (`docs/DATA_MODEL.md`). **Unlike the rest of the staff
surface, the writes run under the BFF service client** (staff Slot access is readonly by
design; the staff session still gates the route — S4's "via BFF" pattern and attribution
tradeoff). Success: `201` with the created event (the `events[]` shape above).

`400 invalid_request` (unknown type, bad date/times, unknown practitioner, title too
long) · `401 unauthorized` · `403 forbidden` (non-staff principal).

### `DELETE /staff/events/:id`

Deletes an internal event and frees its blocked time (slots first, then the appointment —
a failed delete stays visible and retryable). Success: `204`. Patient appointments are
untouchable AND unenumerable through this path: they answer `404 not_found`, identical to
an unknown id. `401 unauthorized` · `403 forbidden` (non-staff principal).

## Change discipline

New endpoints land with: session gating decided explicitly, error codes added to the enum here
and in `@medibun/api-client`, contract tests, an AccessPolicy review if the route touches PHI,
and this file updated in the same PR (definition of done).
