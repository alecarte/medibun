# v0 Proposal — the Aureva launch cut

**Status: PROPOSED — awaiting Alec's approval. Nothing below is being built until sign-off.**

Author: Fable session, 2026-07-02. Inputs: whole-repo exploration (docs, all four apps, packages,
infra, CI), an adversarial skeptic pass on this cut (findings folded in below, several verified
against the Medplum **v5.1.9 source tag**, not docs), and a 4-concept / 3-judge design panel for
the design language. Step zero is done: PR #9 (auth sessions) is merged to `main` (`e46f825`,
merged by Alec 2026-07-02), CI green.

This document is the living record of v0: as slices land, their status is updated here so any
fresh session can resume from the repo alone.

---

## 1. The one thing v0 must prove

**Medical software doesn't have to feel like medical software.** One spine journey, taken to
production polish on synthetic data:

> A patient books an injectable visit online in a beautiful, fast portal → front desk checks her
> in with one tap → the clinician charts the treatment by speaking/typing shorthand, which AI
> drafts onto an interactive face-map for human confirmation → structured FHIR is written,
> audited, with AI-assistance provenance → the patient sees her treatment history on her own
> face-map and gets grounded answers from a concierge that cites her record.

This cut showcases both halves of the thesis: the "Starbucks" consumer feel (booking, history,
concierge) and the "unburdened" clinical side (ambient capture that feels like magic, not forms).
AI is the headline in both directions — capture in, concierge out.

**A stated bet:** with Stripe deferred (§5), v0 demos **zero** commerce/membership/loyalty
mechanics. v0 proves the thesis on beauty, speed, and AI alone; the commerce loop is the first
post-v0 work. And v0's patient surface is web — it proves "beautiful, fast, AI-native," not yet
the app-in-your-pocket loop (mobile rationale in §2).

## 2. Surfaces: built to polish vs. stubbed

| Surface                      | v0 treatment                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/portal` (patient web)  | **Polish.** Login, booking, treatment-history face-map timeline, concierge chat.                                                                                                                                                                                                                                                                                                                                                        |
| `apps/staff`                 | **Polish, two screens.** Today/check-in view (front desk) and encounter capture with the interactive face-map + ambient AI (clinician). Staff login.                                                                                                                                                                                                                                                                                    |
| `apps/api` (BFF)             | **Grows the spine.** Booking, capture, history, and AI endpoints; experience-DB service catalog; the AI choke-point module.                                                                                                                                                                                                                                                                                                             |
| `apps/patient-mobile` (Expo) | **Stubbed** (stays scaffold). Deferred, not dropped: one polished patient surface beats two half-done; App Store review + the still-missing Apple Developer account make mobile unshippable in v0 regardless. Honest caveat: tokens/restyle theming carry over, but Expo auth (secure-store sessions), navigation, and the jest-expo rig are real work deferred with it. The Apple Developer paperwork clock still starts **now** (§7). |

Signup is also trimmed: the spine starts at "books," with the demo patient pre-provisioned by
seed. Patient self-signup (CAPTCHA, rate limits, email verification) is deferred post-v0 — and
with it, **phone OTP**: AUTH.md decided "phone OTP when online booking launches," so deferring it
for the synthetic-only v0 is a re-deferral of an accepted decision that needs Alec's explicit OK
(§5, ask A1). QR check-in, geofencing, loyalty: Phase 2, out.

## 3. AI features (the headline) — what's real vs. synthetic-demo

All three v0 AI features make **real LLM calls** (latest Claude models via the Anthropic SDK)
behind one BAA-gated choke-point module — on **synthetic data only** until the Anthropic BAA is
signed. Nothing in the demo path is smoke-and-mirrors; if a feature can't be grounded, it doesn't
demo.

1. **Ambient clinical capture** (clinician-facing — the flagship). Shorthand or dictation → Claude
   parses to a structured draft (products, doses in units, SNOMED sites, lots, face-map
   coordinates) rendered on the interactive face-map → the clinician reviews, adjusts, and
   **confirms before anything is written**. Writes are `MedicationAdministration` per
   product-per-site with the `injection-point` extension per the accepted data model, plus
   `AuditEvent` and a `Provenance` resource marking AI assistance on every confirmed write.
   Regulatory lane: scribing/documentation with mandatory human confirmation — not a
   recommendation engine. The draft always shows its source text (its basis) for independent
   review.
2. **Patient concierge** (portal chat). **Administrative/informational scope only**: booking help
   ("book my usual"→ proposes a slot, human confirms), service-menu questions, and
   treatment-history recall grounded in the patient's own record with citations that link to the
   history UI. Skeptic-verified regulatory correction: the FDA non-device CDS criteria apply only
   to **HCP-facing** software, so the concierge cannot ride that lane — it stays administrative.
   Concretely: **aftercare content shown to patients is practice-authored (canned), surfaced by
   the concierge — never LLM-generated care advice.** This line is drawn in ADR-0004.
3. **Staff copilot: visit summary** (small). Drafts a visit summary/follow-up from the structured
   encounter data; HCP-facing, shows its basis, human edits/approves.

Deferred AI (Phase 2, the growth engine on Bots/Subscriptions where it belongs): no-show risk,
smart scheduling, proactive rebooking nudges.

**The AI boundary is part of the work:** one module (`packages/ai` or `apps/api/src/ai`) is the
only place the Anthropic SDK is imported — provider/model swappable, PHI gate shut by
construction (synthetic-only until BAA, then approval-gated exactly like Medplum), prompts and
completions under the same no-PHI-in-logs discipline. ADR-0004 (provider, model tier, boundary
module, prompt-logging + provider data-retention rules, the patient-facing content line) is
written and approved **before** the first LLM call, and adding the SDK is treated as the
dependency-approval gate it is (§5, ask A5).

## 4. Slice sequence — vertically-sliced, independently-shippable PRs

Every slice: TDD, small diff, security-reviewer where PHI/auth/AccessPolicy is touched,
runs end-to-end on synthetic seed data before merge. **The seed script and the one-command demo
grow with every slice from S3 onward** — the demo never regresses to magic incantations. CI stays
green on `main`.

| #   | Slice                               | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Verify step                                                                                                           |
| --- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| S1  | Design-system foundation            | Token expansion (type scale, elevation, motion, semantic layer), `brand.aureva.json`, portal + staff app shells in the new design language; raise dev Medplum `defaultLoginRateLimit` in docker-compose (demo logs in 3 principals fast).                                                                                                                                                                                                                                                                                                                                                                                                                                  | Shells render both brands via `[data-brand]`; contrast checks pass; typecheck/lint/test green.                        |
| S2  | Portal patient auth                 | **Patient AccessPolicy template lands here** (not later — real sessions must never run in a policy-less project; includes rebinding the seeded patient membership). Login/logout UI, session handling, `/patients/me` profile page. **Removes `API_DEV_UNAUTHENTICATED` + `/dev/patient`** (the decided replace-not-extend item).                                                                                                                                                                                                                                                                                                                                          | Live login → profile → logout on local stack; security-reviewer PASS; Alec merges (auth).                             |
| S3  | Booking groundwork (FHIR + seed)    | **Data-model amendment (approval-gated, §5 A2):** `HealthcareService` per bookable service carrying Medplum `SchedulingParameters`, reconciled with the experience-DB catalog row; booking uses **`$find` + `$book` only** — skeptic verified against the v5.1.9 source that `$hold/$confirm/$cancel` don't exist at our pin (DATA_MODEL.md gets a review-log correction; no checkout step needs a hold with Stripe deferred; `$find` is instance-level per Schedule, so the BFF fans out). Seed grows: org-aureva, Location, Practitioners, Schedules (timezone ext + SchedulingParameters), services. Experience-DB `services` migration (approval-gated schema change). | Seeded services/slots queryable via BFF `$find` fan-out; migration reviewed; demo command documented.                 |
| S4  | Booking backend + portal booking UI | BFF booking endpoints + api-client methods; portal flow: discover services → pick practitioner/time → book, optimistic UI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Live: book a slot end-to-end as the seeded patient; double-booking rejected (Medplum owns it).                        |
| S5  | Staff foundation                    | Staff seed path (Practitioner, PractitionerRole, org membership — seed identities constrained so nobody holds two memberships, avoiding the multi-membership 501). **Front-desk + clinician org-parameterized AccessPolicy templates + `$set-accounts` grant (approval-gated, §5 A3)**. Staff login. **MFA decision (§5 A4) is made before this slice starts.** Today/check-in view. **Check-in Bot creates the Encounter** (front desk has no Encounter write per the accepted policy table; clinical event logic belongs in Bots — boundary discipline).                                                                                                                 | Front desk logs in, sees today's bookings, checks patient in → Bot-created Encounter visible; security-reviewer PASS. |
| S6  | AI ADR + boundary module            | ADR-0004 approved (§5 A5), then the choke-point module with the BAA gate shut, provider swappable, prompt-logging rules enforced in code. No feature yet — the gate itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Unit tests: PHI gate blocks by default; no SDK import outside the module (lint rule).                                 |
| S7  | Face-map manual capture             | Interactive face-map canvas in staff encounter view; manual capture → `MedicationAdministration` per site + `injection-point` extension (its final shape is set here, with the canvas — closing the data-model deferred item), `Medication` per product+lot, `Procedure` as `partOf` anchor, AuditEvent.                                                                                                                                                                                                                                                                                                                                                                   | Live: capture 3 sites manually → resources verifiable in Medplum; security-reviewer PASS.                             |
| S8  | Ambient AI capture                  | Shorthand/dictation → Claude draft on the face-map → human confirm → same write path as S7 plus `Provenance` marking AI assistance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Live: dictate the demo script's treatment → confirm → FHIR + AuditEvent + Provenance verified.                        |
| S9  | Treatment history timeline          | Portal read path: history endpoints + the patient-facing face-map timeline (built **before** the concierge so the concierge grounds over real endpoints and its citations link to real UI).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Live: today's captured visit renders on the patient's timeline.                                                       |
| S10 | Patient concierge                   | Grounded chat over history endpoints + service menu; booking proposals human-confirmed; practice-authored aftercare content; citations open the history UI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Live: "what did I get last visit?" answers with citation; "book my usual" proposes a real slot.                       |
| S11 | Staff copilot + demo polish         | Visit-summary draft; perf budget pass (below); `design:accessibility-review` on all built surfaces; demo rehearsal against the §8 script.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | The §8 demo runs start-to-finish from the one-command setup, budgets met.                                             |

Reordering within this sequence to unblock a dependency is mine; changing the cut's scope or
dropping a slice is a re-cut → Alec.

**Performance budgets (held, not vibes):** p75 LCP < 2.0s and INP < 200ms on every spine screen;
sub-100ms perceived interactions via optimistic UI. Accessibility: WCAG 2.1 AA on everything
built.

## 5. Approval-gated items this cut touches — batched as one ask

- **A1 — The cut itself** (this doc), including: mobile stubbed, Stripe memberships deferred out
  of v0 (an explicit Phase-1 re-scope), signup trimmed, and the **re-deferral of the accepted
  "phone OTP when booking launches" decision** (AUTH.md) to post-v0/real-data — needs your OK in
  writing, recorded in AUTH.md's review log.
- **A2 — Data-model amendments** (DATA_MODEL.md review log): (i) `HealthcareService` +
  `SchedulingParameters` per bookable service (required by `$find` at v5.1.9 — verified in
  source); (ii) booking ops corrected to `$find`/`$book` only at our pin ($hold/$confirm/$cancel
  don't exist in 5.1.9; adopting them later is a Medplum-pin question, and the 5.1.x lockstep is
  locked stack); (iii) `injection-point` extension final shape lands with S7's canvas.
- **A3 — AccessPolicy creation** (the big one; all least-privilege/default-deny, landed via
  reviewed code + security-reviewer): patient-compartment template (S2), front-desk + clinician
  org-parameterized templates (S5), binding policies to the seeded memberships **and the BFF
  ClientApplication** (today a policy-less membership = full project access — the current dev
  setup contradicts AUTH.md's own least-privilege table), the `$set-accounts` grant for org
  tagging, and (optional, makes logout revocation authoritative — the standing deferred item) the
  scoped `Login` grant for the service client.
- **A4 — Staff MFA for v0**: AUTH.md says staff invites always set `mfaRequired: true`, and MFA
  login currently 501s. Two options, your call **before S5**: (a) build brokered TOTP
  verify/enroll now (Medplum 5.1.9 has the `/auth/mfa` router — buildable, but AUTH.md itself
  flags the brokered UX as a real budget item), or (b) approve non-MFA synthetic dev staff for
  v0 with MFA landing before any real staff account. I recommend (b) for v0 speed with (a) as an
  early post-v0 slice — but it's a control decision, so it's yours.
- **A5 — Anthropic SDK + ADR-0004** (new dependency; PHI-touching once the BAA gate opens).
- **A6 — Experience-DB schema migrations**: `services` catalog (S3); any later additions flagged
  per-slice.
- **A7 — Check-in Bot** (new Bot + Subscription; stated here so Encounter creation ownership is
  explicit — the Bot creates it, not the BFF, per the policy table + boundary discipline).

## 6. Design language direction — **Thermae: Warm Light on Stone**

Chosen by a judge panel: 4 genuinely distinct concepts (spa-sanctuary / editorial-print /
consumer-wellness / luminous-glass), scored by 3 independent judges (consumer-brand, clinical-
workflow, and design-systems/a11y lenses — each recomputed the concepts' WCAG contrast math
before scoring). **Unanimous winner: Thermae**, hardened with grafts from the runners-up.
Judges' one-liner: Thermae's identity survives mediocre execution because it lives in
enforceable tokens and its verified contrast math needs no per-brand exceptions; MASTHEAD
(editorial) lost on its photography/curation dependency, Crema (consumer-wellness) on a real AA
failure in its primary button and template-adjacency, Afterglow (luminous-glass) on a dark/light
staff split that doubles the QA matrix plus GPU-expensive glass effects.

### Thesis

Medibun feels like walking from a bright street into a good spa: the light warms, sound drops,
someone already knows your name. The UI is one constant warm-material room — linen surfaces,
stone text, water-like motion — and each brand changes only **the light in the room** (accent,
glow, a temperature nudge), never the room itself. No pure white, no pure black, no cold grey
anywhere: the literal opposite of legacy EMR.

### Palette (all ratios computed)

**Constant neutral axis (hue ~38–42°):** linen-0 `#FBF8F3` (app canvas), paper `#FFFEFB`
(cards/data, the only near-white, always layered on linen), linen-100 `#F3EEE5` (wells, table
headers), stone-200 `#E2DACB` (decorative hairlines only), stone-500 `#857A6A` (interactive
borders/icons, 3.97:1), stone-600 `#6B6153` (secondary text, 5.73:1), basalt-900 `#28221A`
(ink, 14.9:1).

**Shared warm semantic set:** success moss `#3F6B3D` (5.86:1) · warning ochre `#8F5A10`
(5.45:1) · danger madder `#A63A2A` (6.08:1) · info deep-teal `#2F6D73` (5.57:1). Status chips:
50-tint wash + 700-grade text (≥6:1) + solid 8px dot + label — glanceable at row-scan speed,
never color-alone.

**Aureva (aesthetic, indulgent):** bronze-700 `#8A5A2E` actions (5.53:1; white-on-bronze
5.86:1), blush wash `#F1DFD3`, champagne glow gradient `#F6E7D2→transparent`, control radius
10px, warm paper tint.
**Handal (surgical, authoritative):** palm-700 `#2E4B3F` (9.03:1; white-on-palm 9.57:1), sage
wash `#E4EAE3`, ivory glow, control radius 6px, ink/paper nudged cooler — real surgical distance
beyond the accent. Both accents pass 4.5:1 as normal text, so **no per-brand contrast exceptions
ever ship**.

### Typography (open-license, Google Fonts)

- **Display:** Fraunces variable — Aureva SOFT=100/WONK=0 (poured, rounded); Handal SOFT=0
  (incised) via one `fontVariationSettings` token. Display slots only, enforced by typography
  role tokens (`typography.display/title/body/label/kicker/data`), never below 20px — the
  rationing rule lives in token shape, not policy. Dating risk priced in: swapping the display
  face is a one-token change.
- **Text/UI:** Instrument Sans 400/500/600. Patient scale (1.2): 14/16 body → 44 display,
  line-height 1.55. Staff: 13/14 body, line-height 1.35, same tokens × compact multiplier.
- **Data:** Fragment Mono for reference codes/timestamps/dosage units; `tabular-nums` on every
  numeric column. Eyebrow kicker (11–12px caps, +0.04em) above section titles, system-wide.

### Shape, depth, surfaces

River-stone geometry: inputs/chips 10px (Handal 6px), cards 16px, feature 20px, sheets 28px top,
CTAs full pill. Three linen layers: linen-0 room → paper cards → linen-100 wells. Shadows are
warm light, never black: basalt-tinted (`rgba(40,34,26,…)`) at three elevations. Staff tables
drop shadows entirely — broadsheet discipline: paper-on-linen, horizontal hairlines only, no
zebra, selection = 2px accent left-rule + brand wash (zero layout shift). Hairlines always
accompany surface shifts on mobile (cheap-panel ΔL guard); low-end fallback tokens ship opaque
equivalents for every gradient/tint.

### Motion

One easing family `cubic-bezier(0.22,1,0.36,1)`, durations 120/200/320/600ms, opacity+transform
only, no bounces. Optimistic UI as physics: actions "set down" instantly; the server merely
confirms. Signature moments: **Sunrise Confirmation** (brand glow blooms radially behind the
confirmation card, 600ms), **Ritual Stepper** (steps settle like folded linen; liquid-fill
progress pill), **Stone Settle** (staff optimistic writes: row lifts 1px, settles with an
accent-wash flash — no row-level spinners, ever), **Glowline** (a 1.5px accent beam along a
card's top edge as the peripheral pending cue for background syncs). Every moment has a
`prefers-reduced-motion` crossfade.

### Staff density — same language, work register

Density is a token dimension (`[data-density]` / restyle density object): spacing ×0.75,
controls 40→32px (`control.height`, `row.height` component aliases), compact type. The room
stays warm; hierarchy comes from three-surface layering + tabular numerals, not grey borders.
Accent is rationed to primary action, active nav, focus. Fraunces appears exactly once per
screen ("Today", "Room 3"). A 40-row day-sheet scans at ten feet with zero cold pixels.

### Token implications

Three DTCG layers: `base.json` (linen/stone/basalt ramps replacing the grey ramp; status
primitives; shadow/typography/motion/gradient tokens), `semantic.json`
(`color.surface/text/border/action/status`, `elevation`, `density`, plus a reserved
`neutral.temperature` alias slot — the pre-planned escape hatch if a future tenant demands cool
neutrals), and `brand.aureva.json` / `brand.handal.json` (~14 aliases: accent ramp, wash, glow
gradient, display axis settings, control radius, ink/paper temperature nudge, logo). Brands may
only override `brand.*` — structurally enforced. CI additions: a contract test asserting both
emitted themes (CSS vars + restyle) expose identical semantic key sets, and token-usage lint
rules for the named contrast traps. A **warm-dark theme** (basalt room, luminous accents) is
specced in v0 as a mode of the same semantic layer — not deferred — since mobile OLED users
expect it.

### Accessibility commitments

WCAG 2.1 AA verified in CI, not eyeballed: body ≥4.5:1 on every surface it sits on; interactive
borders/icons ≥3:1 (stone-500); focus ring 2px accent + 2px offset. Named traps with token-level
guards: stone-200 never aliased to interactive slots; stone-500 text restricted to true
large-text sizes (≥18.66px bold / 24px); no text over glow gradients; status always
color+icon+label; deuteranopia-checked semantic pairs.

## 7. External asks of Alec — start the clocks now

| Ask                                                                                                     | Why                                                                                 | Lead time         |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------- |
| Medplum Cloud account + **BAA**; onboarding: raise project `loginRateLimit`, enable audit-log streaming | Prod clinical core; the login cap is launch-critical (shared Vercel egress IPs)     | Weeks — start now |
| **Vercel Pro + HIPAA add-on**                                                                           | Hosting portal/staff/BFF with real PHI                                              | Days–weeks        |
| **GitHub Pro** → branch protection on `main`                                                            | CI green on main stays enforced, not honor-system                                   | Minutes           |
| **Renovate app install**                                                                                | `renovate.json` already in repo, app never installed                                | Minutes           |
| **Apple Developer enrollment**                                                                          | Mobile is stubbed but the clock is slow; App Store review is a Phase-floor gate     | Days–weeks        |
| **Anthropic BAA**                                                                                       | Blocks only real-PHI AI; synthetic-data AI proceeds now. Start the paperwork anyway | Weeks             |
| (Standing, Phase 3 clocks, not v0-blocking): DoseSpot enrollment, 4D export sample                      | Roadmap Phase 0 outstanding items                                                   | Long              |

## 8. The v0 acceptance demo script — the standard for "done"

**Personas (all synthetic):** Mia Tan (patient) · Noor (front desk) · Dr. Reyes (injector).

**Setup (one documented command sequence, maintained from S3 onward):**
`cd infra/medplum && docker compose up -d && ./setup-dev.sh && pnpm demo:seed && pnpm dev`

1. **Mia books.** Mia logs into the portal (no MFA — patient). She asks the concierge "what's the
   difference between Botox and Dysport here?" — it answers from the Aureva service menu, cited.
   She books a Botox appointment for today with Dr. Reyes: discover → pick time → confirm, every
   interaction under 100ms perceived, the whole flow feeling like a premium consumer product.
2. **Noor checks her in.** Noor logs into the staff app, sees today's schedule with Mia's booking,
   taps check-in. (Behind the scenes: Appointment → arrived; the check-in Bot creates the
   Encounter.)
3. **Dr. Reyes charts by voice.** She opens the encounter, dictates: "Botox 50 units total,
   glabella five sites 4-4-4-4-4, lot C3421A, exp next March." The AI drafts five injection
   points onto the face-map with doses, sites, and lot. She drags one point to adjust, confirms.
   FHIR writes land: 5 × `MedicationAdministration` (+ injection-point extensions) → `Procedure`
   → Encounter, `Medication` with lot C3421A, `AuditEvent` + `Provenance` (AI-assisted) on every
   write — verifiable in Medplum.
4. **The copilot summarizes.** Dr. Reyes accepts an AI-drafted visit summary (edits one line —
   human always in the loop).
5. **Mia sees it.** Back in the portal, Mia's treatment history shows today's visit on her own
   face-map. She asks the concierge "what should I avoid tonight?" — it surfaces Aureva's
   practice-authored post-Botox aftercare (canned content, cited), and "when should I come back?"
   proposes a rebooking slot she can confirm.

**Pass bar:** the walkthrough runs end-to-end from the one-command setup with zero manual fixups;
budgets met (p75 LCP < 2.0s, INP < 200ms, spine screens); a11y review passed; every AI answer in
the demo is grounded and cited (no smoke-and-mirrors); all writes audited and attributable;
**Alec's demo sign-off is the explicit bar for the subjective half.**

## 9. Slice status log

| Slice  | Status      | Notes                       |
| ------ | ----------- | --------------------------- |
| S1–S11 | Not started | Awaiting proposal approval. |

## 10. Review log

- 2026-07-02 — Proposed (this document). Skeptic findings folded in: $hold/$confirm/$cancel
  absent at Medplum v5.1.9 (verified in source) → $find/$book only; HealthcareService +
  SchedulingParameters dependency surfaced; AccessPolicy moved up to S2/S5; concierge scoped
  administrative (patient-facing ≠ HCP-CDS lane); phone-OTP re-deferral made explicit; history
  timeline sequenced before concierge; seed/demo grown per-slice; Encounter creation assigned to
  a check-in Bot; dev login-rate-limit raise added to S1.
