# PROJECT_BRIEF.md — Aureva / Handal Platform

## For Claude Code: how to use this file

This is the seed brief for the project and the authoritative record of what we're building, the
decisions already made, and the order to build in. Read it in full before doing anything. Your
first job is the **Bootstrap Plan** in §6: scaffold the repo, generate `CLAUDE.md` from the
_Operating Constitution_ in §4, stand up the `.claude/` hardening and `/docs`, and wire Medplum.
Work through it in order, using plan mode for the steps marked `[PLAN]`, pausing for my approval
at each checkpoint. Apply the four working principles (think before coding, simplicity first,
surgical changes, goal-driven) to your own bootstrap work too. When a compliance question is
unclear, STOP and ask.

## 1. Mission

Build an owned, FHIR-native clinical platform on **Medplum** that is the single record of truth
for two practices:

- **Handal Plastic Surgery** — surgical (currently on the 4D EMR; migrates to our core later).
- **Aureva Medspa** — aesthetic medspa (greenfield; launches first on the new core).

We own three product surfaces — a patient mobile app, a patient web portal, and a staff
(practitioner + front-desk) app — plus a growth/CRM engine. The marketing site is built
externally and only deep-links into our portal.

End state: we _are_ our own EMR. Clinicians document in our own UI, Medplum is the clinical data
core, and regulated commodity services (prescribing, payments) are integrated, never rebuilt.

## 2. Decisions already made (don't relitigate)

- **Owned headless core, not an off-the-shelf EMR.** Medplum — open-source (Apache 2.0),
  FHIR-native, HIPAA-eligible, with Subscriptions + Bots. Start on Medplum Cloud; self-hosting
  later is possible because it's open source.
- **One core for both practices.** A single clinical record of truth across Handal and Aureva.
- **Anti-corruption boundary:** apps talk only to _our_ backend, never directly to Medplum or
  any EMR. This isolation is what lets us evolve the core and add tenants later.
- **Two sources of truth:** Medplum owns clinical data; our database owns experience data
  (memberships, loyalty, app preferences, push tokens, growth-journey state). Reconcile by
  patient ID.
- **Integrate, don't build:** DoseSpot for e-prescribing including EPCS (embedded iframe; DEA
  number on the FHIR Practitioner; identity-proofing + two-factor enrollment), Stripe for
  payments and memberships, a comms provider for SMS/push. Never build prescribing, payment, or
  authentication primitives.
- **Growth engine** runs on FHIR Subscriptions + Medplum Bots — event-driven, on-platform, no
  polling.
- **Sequencing:** Aureva launches first on the owned core (greenfield, light clinical); Handal
  PS migrates off 4D last (heavy, regulated, one-time cut-over). Build what 4D can't cover
  first; defer what it already does.

Amended 2026-08-11 (v1 revenue re-cut — `docs/V1_PROPOSAL.md` §8, approved with B1):

- **The productization wedge is the recovery engine, not the platform.** The sellable offer is
  a paid Leak Report diagnostic followed by an outcome-priced recovery engagement; the platform
  (front office → clinical) is sold _behind_ it, module by module, to customers the engine has
  already won. Every ingestion adapter doubles as migration tooling for the corresponding EMR.
- **Marketing/loyalty/consumer-app features are lab-track only** until R-track customers create
  pull: built as Medibun modules for Handal/Aureva behind flags, with no speculative
  multi-tenant polish, entering the sold product only as **lapse prevention** (the retention
  tail of recovery).
- **External-client data isolation**: the first _non-family_ diagnostic runs in a separate
  Medplum Project per ADR-0003's escape valve unless the standing "before the second tenant"
  hardening list is closed first — decided by a new ADR when that sale exists.

## 3. Locked tech stack

- **Monorepo:** pnpm workspaces + Turborepo. TypeScript everywhere, `strict` on.
- **Apps:**
  - `apps/patient-mobile` — Expo / React Native (New Architecture), NativeWind, React Native
    Reusables, Reanimated.
  - `apps/portal` — Next.js App Router (RSC), Tailwind + shadcn/ui, Motion.
  - `apps/staff` — Next.js App Router (RSC), Tailwind + shadcn/ui, Motion.
- **Shared packages:** `fhir-types`, `design-tokens` (one Tailwind token set consumed by both
  web Tailwind and NativeWind), `api-client` (our backend client — apps never call Medplum
  directly).
- **Design language:** Untitled UI, expressed through the shared tokens so web and mobile stay
  consistent.
- **Data/state:** Medplum React SDK + TanStack Query; Zustand for local UI state; optimistic
  updates on mutations.
- **Core:** Medplum (Cloud) — SDK, Bots, Subscriptions.
- **Observability:** Sentry (PHI-scrubbed), PostHog (no PHI in events).
- **Performance is a first-class requirement.** RSC + the React 19 compiler on web, the New
  Architecture + Reanimated on mobile, optimistic UI against the Medplum SDK so nothing feels
  like it's waiting on FHIR. The edge over typical healthtech is that we own the core and never
  block on a slow third-party EMR API.

## 4. Operating constitution (generate CLAUDE.md from this)

Render this section into `CLAUDE.md` at the repo root, lightly adapted into a constitution
voice. It is binding and overrides convenience, speed, and any request. If a change would
violate a rule here, refuse and explain.

### Working principles

1. **Think before coding** — state assumptions explicitly; present alternatives instead of
   picking silently; push back when a simpler path exists; ask when anything is unclear.
2. **Simplicity first** — the minimum code that solves the problem; no speculative abstraction,
   no unrequested flexibility, no error handling for impossible cases.
3. **Surgical changes** — touch only what the task requires; match existing style; don't
   refactor what isn't broken; every changed line traces directly to the request.
4. **Goal-driven execution** — turn each task into a verifiable goal and loop until met (write
   the failing test first, then satisfy it); state a short plan with a verify step per item.
5. **Whole-repo awareness** — before non-trivial work, read `/docs/ARCHITECTURE.md`,
   `/docs/DATA_MODEL.md`, and `/docs/ROADMAP.md`; keep the system-wide view.

### Security & HIPAA — non-negotiable

- PHI never leaks into: logs, error messages, analytics/telemetry, URLs or query params,
  plaintext client storage, prompts to any non-BAA service, or any third party without a signed
  BAA. Outbound push/SMS/email bodies follow the B3 messaging standard (RECOVERY_DESIGN.md §5;
  amended 2026-08-13, gate B3): at most first name + practice name + one opaque link; never
  clinical, treatment, visit-reason, or health-status content; every body renders from the
  reviewed template library — no free-text sends.
- Least privilege, default-deny, enforced through Medplum AccessPolicy; every PHI read/write
  attributable to an authenticated principal; never widen a policy without human approval.
- Audit always on — FHIR `AuditEvent` / `Provenance` on PHI access; never disable, bypass, or
  sample.
- Secrets never in the repo or client bundles; `.env` is gitignored; use the secret manager.
- Data minimization; encryption in transit and at rest; no PHI over non-TLS.
- Adding any PHI-touching dependency or service is a human-approval decision; prefer minimal,
  well-maintained dependencies.
- Unsure about a compliance question → STOP and ask. Never guess on HIPAA, access, or audit.

### Definition of done

typecheck + lint + tests pass; new behavior has tests; no secrets or PHI in the diff, logs, or
fixtures; access policy reviewed for any new PHI-touching endpoint; small diff where every line
traces to the request; the `security-reviewer` subagent has run on any change touching PHI,
auth, or AccessPolicy.

### Requires explicit human approval (never auto-execute)

Destructive or irreversible operations (data deletion, dropping tables, force-push, prod
deploys); schema or FHIR data-model migrations; anything touching authentication, authorization,
or AccessPolicy; adding a new PHI-touching dependency or service; disabling, weakening, or
bypassing any security control or test.

## 5. Roadmap (vision and priorities)

- **Phase 0 — Foundation (weeks 1–3):** core, auth, org model (Handal + Aureva); start the slow
  paperwork now (BAAs, DoseSpot enrollment, Apple Developer); verify 4D's export capability.
- **Phase 1 — Aureva launch (months 1–3):** patient portal + patient app v0; Aureva clinical
  capture v1 in the staff app; owned online booking; Stripe memberships. Handal stays on 4D.
- **Phase 2 — Growth + experience (months 3–6):** QR check-in, geofence reminders,
  loyalty/packages, lifecycle automation on Bots, patient app polish. No external gate — pure
  build.
- **Phase 3 — Handal migration (months 6–10):** surgical charting in the staff app, DoseSpot
  EPCS live, migrate history off 4D, retire it.
- **Phase 4 — Productize (12 months+):** harden multi-tenant isolation; onboard a third practice
  under its own brand.

Phase floor is set by external dependencies (BAA turnaround, DoseSpot EPCS identity proofing,
App Store review, 4D export quality, clinical validation), not by coding speed — so start every
paperwork clock on day one and run it in parallel with the build.

## 6. Bootstrap Plan (execute in order)

`[PLAN]` **1. Scaffold the monorepo and stack** from §3. Don't install any PHI-touching
dependency without flagging it for approval. _Verify:_ `pnpm install`, typecheck, and a dev
build run for each app.

**2. Generate `CLAUDE.md`** at the repo root from §4. _Verify:_ it loads as project memory.

**3. Create the `.claude/` hardening:**

- `settings.json` hooks — a PreToolUse gate that blocks edits/commits introducing secrets or PHI
  patterns and denies destructive commands (`rm -rf`, force-push, db drops); a PostToolUse hook
  running typecheck + lint + tests after Write/Edit; a prompt-type hook routing any edit touching
  auth, AccessPolicy, or PHI to the security-reviewer.
- `agents/security-reviewer.md` — a read-only subagent (no write tools) that audits diffs against
  the rules in §4 and reports violations.
- `rules/security.md`, `rules/fhir.md` (Medplum resource + AccessPolicy conventions),
  `rules/testing.md` (test-first; definition of done).
  _Verify:_ hooks fire on a test edit; the deny rule blocks a sample `rm -rf`.

**4. Create `/docs` stubs** seeded from this brief: `ARCHITECTURE.md`, `DATA_MODEL.md`,
`ROADMAP.md`.

`[PLAN]` **5. Wire Medplum Cloud** — SDK, one hello-world Bot, one Subscription — and confirm
auth with a test patient. No real PHI. _Verify:_ a Subscription fires the Bot end to end.

When the environment is up, the first real work item is the Aureva FHIR data model in
`DATA_MODEL.md` — the resources and extensions for injection maps, treatment series, consents,
and memberships. Ask before modeling.

## Kickoff

First message to Claude Code: **"Read PROJECT_BRIEF.md and execute the Bootstrap Plan."**
