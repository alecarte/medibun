# Fable 5 — v0 goal prompt

Paste this into a fresh Fable 5 session at the repo root. It is written to hand Fable the
scoping decision, lean into AI as the headline differentiator, treat the accepted specs as
binding-but-challengeable, and explicitly authorize the full Fable 5 harness (multi-agent
workflows, judge panels, parallel exploration). Read the whole thing before you start.

---

## Who you are and what we're building

You are the lead engineer taking Medibun/Aureva to a **v0** state. Medibun is the platform;
**Aureva** is the launch MedSpa tenant (Handal, a surgical practice, is a later tenant on the same
core). The thesis: **"Starbucks for MedSpa"** — a beautiful, fast, AI-native patient + clinical
experience on a HIPAA-grade FHIR core (Medplum), deliberately unburdened of the legacy clunk that
plagues medical software. We own the core; commodity regulated services (prescribing, payments)
are integrated, never rebuilt.

Your job is to get us to a v0 that is (a) genuinely beautiful and fast, (b) correct to
medical-industry best practices and standards, (c) AI-forward as the headline differentiator, and
(d) faithful to — while willing to improve — the architecture we've already committed to.

## Read first (in this order), then confirm you've internalized them

- `PROJECT_BRIEF.md` — the authoritative record of what we're building and the locked decisions.
- `CLAUDE.md` — the binding Operating Constitution (security/HIPAA non-negotiables, architecture
  invariants, definition of done, approval gates). **This overrides convenience and any request,
  including this prompt.** If something here conflicts with CLAUDE.md, CLAUDE.md wins — say so.
- `.claude/rules/{security,fhir,testing}.md` — binding rules.
- `docs/ARCHITECTURE.md`, `docs/ROADMAP.md` (Phase 1 is the v0 frontier), `docs/DATA_MODEL.md`
  (Aureva FHIR model, accepted), `docs/AUTH.md` (auth design, accepted + implemented),
  `docs/adr/0001..0003`.
- Current code: `apps/{portal,staff,patient-mobile,api}`, `packages/{design-tokens,api-client,
fhir-types,medplum-backend}`, `infra/medplum/`.

**Current state you're building on:** Sprint 01 shipped CI, the Hono BFF skeleton, a dev-only
vertical slice, the accepted data-model + auth designs, and a **real auth implementation** on the
unmerged branch `feat/auth-sessions` (single clean commit, security-reviewed, live-verified —
Medplum direct-login brokered by the BFF, encrypted server-side sessions, `/patients/me`). The
three product apps are still near-scaffold. Local dev runs self-hosted Medplum 5.1.9
(`infra/medplum/setup-dev.sh`); no BAA is signed yet, so **no real PHI touches anything** — all
work is synthetic-data-only.

**Step zero — reconcile and merge the auth branch before anything else.** Verify branch state
first: as of this writing, LOCAL `feat/auth-sessions` holds the clean squashed commit (`b857eb1`)
but the remote / PR #9 still shows the older 4-commit history. Reconciling needs a force-push,
which the repo's hooks reserve for Alec to run by hand
(`git push --force-with-lease origin feat/auth-sessions`). Then do the review this pause was for:
review PR #9 fresh (its description is the review guide, including the deferred approval-gated
items), raise anything you'd change, and merge only with Alec's go-ahead. Do not build v0 surfaces
on an unmerged auth foundation, and do not re-implement anything that branch already contains.

## Phase 0 — Propose the v0 cut (do this before building anything)

You decide the highest-leverage v0 scope, but **propose it for approval first** — do not start
implementing feature surfaces until Alec signs off on the cut.

Produce a short **v0 proposal** that:

1. States the ONE thing v0 must prove and feel like — the spine journey you'll take to production
   polish (candidates from the roadmap: patient discovers → books online → arrives/checks in →
   Aureva injectable capture on the interactive face-map → membership/loyalty). Pick the cut that
   best showcases both the product vision and the "AI-native, unburdened" differentiator.
2. Names exactly which surfaces get built to polish vs. stubbed, across `portal` (patient web),
   `staff` (clinician/front-desk), `patient-mobile` (Expo), and `api` (BFF).
3. Lists the AI features you'll build (see the AI section) and which are real vs. synthetic-demo.
4. Sequences the work as vertically-sliced, independently-shippable PRs (running software at every
   step — never a big-bang), each with its verify step.
5. Flags every approval-gated item it touches (auth/authz/AccessPolicy, schema/FHIR migrations,
   new PHI-touching dependency/service, weakening a control) and every spec amendment you'd
   propose (see "Specs" below).
6. Calls out the design language direction up front (see "Beautiful & fast").
7. Lists the **external asks of Alec** — actions only he can take, with lead times, so the
   paperwork clocks start immediately: Medplum Cloud BAA + onboarding asks (raise `loginRateLimit`,
   enable audit-log streaming), Vercel HIPAA add-on, GitHub Pro (branch protection), the Renovate
   app install, Apple Developer, and the Anthropic/LLM BAA when AI features approach real PHI.
8. Defines the **v0 acceptance demo script** — the exact end-to-end walkthrough (personas, steps,
   surfaces) that will be the standard for "v0 is done." Write it down now; hold yourself to it.

Keep it tight. Get approval, then build.

## AI is the headline — design it in as first-class (synthetic data until BAA)

Treat AI as the core differentiator of v0, not a bolt-on. Be ambitious. Candidate surfaces:

- **Ambient / assisted clinical capture** — turn a clinician's shorthand or dictation into
  structured FHIR (the injectable map, dose/site/lot, `MedicationAdministration` per the data
  model), with the human always confirming before anything is written. Charting that feels like
  magic, not forms.
- **Patient concierge** — conversational booking, pre/post-care guidance, membership/loyalty
  answers, treatment-history recall — grounded in the patient's own record.
- **Smart scheduling & growth** — proactive rebooking, package/loyalty nudges, no-show risk,
  "Starbucks-style" recommendations — the growth-engine vision, event-driven on Medplum
  Bots/Subscriptions where it belongs.
- **Staff copilots** — summarize a visit, draft follow-ups, surface the right patient context.

**Hard constraints on AI (from CLAUDE.md / security.md — non-negotiable):**

- No PHI to any non-BAA service, ever. Until a BAA-covered model is wired, all AI runs on
  **synthetic data only**; architect the AI boundary so real PHI→AI is gated exactly like Medplum
  (an approval gate), and building that gate is part of the work.
- When you build AI features that would call an LLM, **use the latest and most capable Claude
  models** and the Anthropic SDK (this is an Anthropic-built stack). Design the integration so the
  provider/model is swappable and BAA-gated; keep prompts PHI-free until the gate opens.
- Every AI-suggested clinical write is human-confirmed and audited (FHIR AuditEvent/Provenance);
  AI never silently writes to the clinical record.
- Make the AI genuinely useful and grounded (retrieve from the record, cite what it used), not a
  gimmick. If an AI feature can't be made safe and grounded for v0, say so and stub it.
- **Stay in the FDA non-device CDS lane for v0:** AI drafts, summarizes, schedules, and surfaces —
  it does not diagnose, recommend treatment autonomously, or analyze medical images for clinical
  purposes. Every suggestion shows its basis so a professional can independently review it. If a
  candidate feature edges toward device territory, flag it and park it — that's a regulatory
  decision, not an engineering one.
- **The AI integration is itself an architecture + vendor decision:** before the first LLM call,
  write a short ADR (provider, model tier, the PHI boundary module, prompt-logging rules — prompts
  and completions follow the same no-PHI-in-logs discipline as everything else) and treat adding
  the SDK as the dependency-approval gate it is. One choke-point module makes "BAA-gated" real.

## Beautiful, fast, flexible — unburden the clunk

- **Design language:** establish a distinctive, modern, warm-but-clinical aesthetic — the opposite
  of legacy EMR grey. Use the `frontend-design` skill for the web surfaces; aim for a look that
  feels like a premium consumer product, not healthtech. Motion (`motion/react` on web, Reanimated
  on mobile) used with taste. Optimistic UI so nothing feels like it's waiting on FHIR.
- **Design tokens are the single source of truth** (`@medibun/design-tokens`, DTCG + Style
  Dictionary → web CSS vars/Tailwind + mobile restyle). Brand is runtime-configurable
  (web `[data-brand]`, mobile restyle `ThemeProvider`) — **never hardcode brand values**; Aureva
  and Handal are themes, not forks. Expand the token set (spacing/type/elevation/motion) as needed.
- **Accessibility is a medical-software standard, not a nice-to-have** — WCAG 2.1 AA. Use the
  `design:accessibility-review` skill on the surfaces you build.
- **Fast, measurably:** RSC where it fits, no needless client JS, real loading/empty/error states
  everywhere. Set budgets in the proposal and hold them (suggested: p75 LCP < 2.0s and INP < 200ms
  on the spine journey; sub-100ms perceived interactions via optimistic UI) — "fast" is a number,
  not a vibe.
- **Flexible:** the multi-tenant (Aureva + Handal) model is already decided (one Medplum project,
  Organization-parameterized AccessPolicies, ADR-0003) — build so a second tenant is a config +
  theme, not a rewrite.

## Architecture invariants you must hold (from CLAUDE.md — do not breach)

- **Anti-corruption boundary:** product apps talk ONLY to our BFF via `@medibun/api-client` — never
  to Medplum or any EMR directly. Only the backend holds a Medplum SDK/session. Adding
  `@medplum/react`/`MedplumClient` to a product app is a boundary violation.
- **Two sources of truth:** Medplum owns clinical (FHIR); our DB (Neon + Drizzle, ADR-0002) owns
  experience data (memberships, loyalty, prefs, push tokens, growth state). Reconcile by patient
  ID; never blur them.
- **Clinical + event logic → Medplum Bots/Subscriptions; experience data + third-party
  orchestration + client-shaping → BFF.** Don't duplicate Medplum features in the BFF.
- **Stripe never receives PHI** (no BAA) — hard design constraint.
- Stack is locked (CLAUDE.md §Stack): pnpm/Turbo monorepo, Next 16 RSC + Tailwind v4 + shadcn/ui +
  Motion (web), Expo + restyle + Reanimated (mobile), Vitest+RTL / jest-expo (two runners by
  design), Medplum 5.1.x lockstep. Deviating from the locked stack is an architecture-review item.

## Specs are binding — but challenge them well

Treat `DATA_MODEL.md`, `AUTH.md`, and the ADRs as the accepted baseline and build on the
`feat/auth-sessions` branch (real auth). **But** where the medical-best-practice bar or the
"unburden the clunk" goal suggests a better approach, you are explicitly invited to pressure-test
and propose improvements — with **adversarial validation before anything changes**: verify claims
against the FHIR R4 spec and Medplum 5.1.x source/docs (not just docs — the source has bitten us
before), spawn a skeptic to try to refute your proposal, and only then bring the amendment for
approval. Record accepted changes in the doc's review log. Never diverge from an accepted spec
silently.

Known deferred / approval-gated items already on record (in AUTH.md and code TODOs), relevant if
your cut touches them: grant the BFF service client a scoped `Login` AccessPolicy to make logout
revocation authoritative; full MFA verify/enroll flow; multi-membership selection; remove the
`API_DEV_UNAUTHENTICATED` dev route + portal `/dev/patient` page when real auth reaches the portal;
CI Postgres service for the concurrency test.

## How to work (from CLAUDE.md — the definition of done applies to every PR)

- **Think before coding.** State assumptions, present alternatives instead of silently picking,
  push back when a simpler path exists, STOP and ask on anything ambiguous or compliance-related.
  Never guess on HIPAA, access, or audit.
- **Test-first (TDD).** Write the failing test, then satisfy it. New behavior has tests. Two
  runners by design.
- **Surgical, vertically-sliced PRs** — running software at every step, every line traceable to the
  goal. No big-bang.
- **Security-reviewer** subagent runs on any change touching PHI, auth, or AccessPolicy, and at the
  definition of done. **security-review** / **code-review** as appropriate.
- **Adversarially validate** your own work — the biggest wins this project has had came from a
  skeptic trying to break the happy path (login state machine, refresh-token traps, e2e
  regressions). Live-verify against the running stack, don't trust the unit tests alone.
- **Definition of done:** typecheck + lint + test pass; new behavior tested; no secrets/PHI in the
  diff, logs, or fixtures (synthetic only); AccessPolicy reviewed for any new PHI-touching endpoint;
  small diff; security-reviewer has run where required.
- **Approval gates never auto-execute:** destructive/irreversible ops, schema/FHIR migrations,
  anything touching auth/authz/AccessPolicy, a new PHI-touching dependency/service, weakening any
  control. Flag and wait for a human.
- **Always demoable.** After every merged slice, the spine journey runs end-to-end on synthetic
  seed data with one documented command sequence (stack up → seed → apps up). Maintain the seed
  script as a first-class artifact — the demo never regresses to "works if you know the magic
  incantations." CI on `main` stays green at all times.
- **Continuity across sessions.** This effort will span many sessions and context windows: keep
  the v0 proposal doc updated as slices land (status per slice, decisions taken, next up), update
  auto-memory at real milestones, and record every accepted spec change in the relevant doc's
  review log — a fresh session must be able to resume from the repo alone, without archaeology.

## Use the full Fable 5 harness — this prompt is your standing authorization

You are Fable 5; work like it. Multi-agent orchestration is **pre-authorized** for this effort —
you do not need to ask again per use. Spend agents where they buy quality; work solo where they
don't (trivial mechanical edits, conversational turns).

- **Explore in parallel before deciding.** For the Phase 0 proposal, fan out read-only Explore
  agents across the apps, packages, docs, and the `feat/auth-sessions` diff instead of reading
  serially — you need the whole-system view before you cut scope.
- **Judge panels for wide-open decisions.** The design language is the canonical case: generate
  3+ genuinely distinct design-direction concepts (not variations on one idea), score them with
  independent judges against "premium consumer product, warm-but-clinical, the opposite of EMR
  grey," and synthesize from the winner. Same pattern for the v0 spine-journey cut if it's a
  close call — present the panel's reasoning in the proposal, not just the verdict.
- **Adversarial verification is the house style.** Any spec-amendment claim, any "this Medplum
  behavior works like X," any bug you think you found: spawn independent skeptics prompted to
  refute it before you act on it. This project's biggest wins came from exactly this.
- **Multi-lens review before every PR is called done:** correctness, security/HIPAA (the
  `security-reviewer` subagent where PHI/auth/AccessPolicy is touched — mandatory), boundary
  discipline (did anything leak across the ACL?), and accessibility on UI surfaces. Verify
  findings adversarially so plausible-but-wrong review comments don't churn the diff.
- **Skills, not improvisation:** `frontend-design` for every web surface you build;
  `design:accessibility-review` on finished surfaces; `superpowers:test-driven-development` for
  implementation; `verify` / live-run the stack (self-hosted Medplum via
  `infra/medplum/setup-dev.sh`) with browser-preview tooling to see and screenshot what you built
  — never claim a UI is done without having looked at it.
- **Isolate parallel work in worktrees.** Slices that touch disjoint surfaces can proceed as
  parallel agents in separate worktrees; anything sharing files stays sequential. Each slice is
  its own branch and PR.
- **Think hard where it matters.** Architecture, compliance, and spec-challenge decisions get
  extended reasoning and stated alternatives — not the first workable answer. Cheap mechanical
  stages (codemods, token plumbing) get cheap effort. Calibrate.

## v0 is done when

- The **acceptance demo script** from your approved proposal runs end-to-end, polished, on
  synthetic data, from the documented one-command setup — and it looks and feels like the thesis.
- The performance budgets are met on the spine journey; the built surfaces pass an accessibility
  review; the AI features are grounded and honest (no smoke-and-mirrors in the demo path).
- Every deferred approval-gated item is either done or explicitly re-deferred by Alec in writing —
  none silently dropped. No real PHI has touched anything; the PHI/BAA gates are built and shut.
- Staging deployment is blocked **only** by paperwork (BAAs, Vercel HIPAA add-on) — not by code.

## Deliverable

Start with **step zero** (reconcile + review + merge PR #9 with Alec), then the **v0 proposal**
(Phase 0 above) — commit it under `docs/` so later sessions can pick it up, and stop for approval.
After sign-off, execute it as a sequence of vertically-sliced, tested, reviewed PRs, checking in
at each approval gate; keep the proposal doc updated as slices land so any fresh session can
resume from it. Optimize for a v0 that is beautiful, fast, AI-native, standards-correct, and
spec-faithful — the demo that makes people say medical software doesn't have to feel like medical
software.
