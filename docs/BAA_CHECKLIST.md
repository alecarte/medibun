# BAA checklist — the paperwork queue

The single admin queue: every BAA the stack needs before real PHI touches it, plus the non-BAA
paperwork clocks. **Owner: Alec** — admin/business paperwork is his queue (decided 2026-08-13);
sessions build against local/stub services and don't chase these. Every clock started at R0
(2026-08-11) **except 10DLC**, which cannot start until the B4 vendor pick — that dependency
makes B4 schedule-critical, not a formality.

**Release rule (binding — `.claude/rules/security.md`):** signing one BAA releases nothing.
Real data stays on practice-controlled hardware until **every** cloud service on the data path
has a signed BAA, and cloud promotion of real data is a **single explicit cut-over** recorded
in [`RECOVERY_DESIGN.md`](RECOVERY_DESIGN.md)'s review log. Rows here track paperwork progress
only. When a BAA signs, append `✓ signed YYYY-MM-DD` to its Status cell and add a review-log
line below.

| Service                                                                                         | Why it needs a BAA                                                                                                                 | Status · lead time                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Medplum Cloud                                                                                   | Clinical source of truth — holds all PHI                                                                                           | Needed before prod PHI · weeks — the long pole, start first                                                         |
| Vercel (Pro + HIPAA)                                                                            | Hosts the BFF + web apps; PHI transits it                                                                                          | Needed before prod PHI · days–weeks                                                                                 |
| Neon (Scale plan, ADR-0002)                                                                     | Experience DB; recovery staging holds patient identity + contact info                                                              | Needed before prod data (ADR-0002) · days–weeks                                                                     |
| SMS vendor — **Twilio** (B4 ✓ 2026-08-13; ADR-0005)                                             | Outbound texts to patient phone numbers                                                                                            | Gates R6 sends · weeks — **start the Twilio BAA now** (it also unblocks 10DLC below)                                |
| Email vendor — SendGrid under the Twilio BAA if terms allow, else **Mailgun** (B4 ✓ 2026-08-13) | Outbound email to patients                                                                                                         | Gates R6 sends · weeks; Postmark and Resend disqualified (no BAA)                                                   |
| Sentry                                                                                          | Error monitoring on the prod stack (PHI-scrubbed by design)                                                                        | Not an automatic R6 blocker: launch-without-observability is Alec's explicit call (flagged in ROADMAP) · days–weeks |
| PostHog                                                                                         | Product analytics (no PHI by design)                                                                                               | Same explicit call as Sentry · days–weeks                                                                           |
| Anthropic                                                                                       | AI modules (S8/S10/S11), post-ADR-0004/A5                                                                                          | Gates L-track real-PHI AI only, not R6 · weeks                                                                      |
| Minduo ↔ Handal                                                                                 | Minduo — Alec's consulting company, the group implementing/operating Medibun — processes Handal's PHI as a business associate (B7) | Gates R6 · days (template + signatures)                                                                             |

Never on this list: **Stripe** — signs no BAA; PHI never reaches it (constitution invariant).

## Other paperwork (non-BAA)

| Item                                                    | Why                                                         | When it gates · lead time                                                                                                                                                                                                               |
| ------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TCPA/consent counsel review (B3 templates + STOP flow)  | Outbound texting to patients; verify the relationship basis | Before R6 sends · days                                                                                                                                                                                                                  |
| 10DLC brand + campaign registration                     | Carrier sender registration; healthcare draws extra vetting | Gates R6; B4 picked 2026-08-13 (Twilio) → **startable now** · ~2–3 weeks + up to 10 business days healthcare vetting. Toll-free is **not** a fast fallback — its verification currently runs 4–6 weeks (corrected 2026-08-13, ADR-0005) |
| DoseSpot enrollment + DEA EPCS identity proofing (IAL3) | E-prescribing                                               | Phase H, pullable forward — hence the R0 start · months, uncompressible                                                                                                                                                                 |
| Apple Developer enrollment                              | Mobile, later                                               | L-track mobile · days–weeks                                                                                                                                                                                                             |

## Review log

- 2026-08-13 — **B4 decided (Alec; ADR-0005)**: Twilio for SMS; email = SendGrid under the
  same Twilio BAA if the enterprise terms are sane, else Mailgun (its own BAA). Actionable
  now, Alec: (1) start the Twilio BAA — ask about SendGrid coverage in the same conversation;
  (2) start 10DLC brand + campaign registration via Twilio Trust Hub (healthcare draws
  enhanced vetting, up to +10 business days). Toll-free note corrected — no longer a fast
  fallback (verification currently 4–6 weeks).
- 2026-08-13 — **Minduo defined (Alec)**: his other company — a consulting group unrelated to
  the practices — acting here as the group running the Medibun implementation, possibly as the
  product's owning company (Alec settles which in the BA agreement itself). Either way it
  processes Handal PHI, hence the BA-agreement row above.
- 2026-08-13 — Created (Alec's division-of-labor decision), consolidating V1_PROPOSAL §7's
  clock table as the single queue. Nothing signed yet; all clocks running except 10DLC
  (blocked on B4).
