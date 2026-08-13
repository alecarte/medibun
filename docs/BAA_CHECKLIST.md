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

| Service                           | Why it needs a BAA                                                    | Status · lead time                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Medplum Cloud                     | Clinical source of truth — holds all PHI                              | Needed before prod PHI · weeks — the long pole, start first                                                         |
| Vercel (Pro + HIPAA)              | Hosts the BFF + web apps; PHI transits it                             | Needed before prod PHI · days–weeks                                                                                 |
| Neon (Scale plan, ADR-0002)       | Experience DB; recovery staging holds patient identity + contact info | Needed before prod data (ADR-0002) · days–weeks                                                                     |
| SMS vendor (B4 pending; ADR-0005) | Outbound texts to patient phone numbers                               | Gates R6 sends · weeks                                                                                              |
| Email vendor (B4 pending)         | Outbound email to patients                                            | Gates R6 sends · weeks; Resend disqualified (no BAA)                                                                |
| Sentry                            | Error monitoring on the prod stack (PHI-scrubbed by design)           | Not an automatic R6 blocker: launch-without-observability is Alec's explicit call (flagged in ROADMAP) · days–weeks |
| PostHog                           | Product analytics (no PHI by design)                                  | Same explicit call as Sentry · days–weeks                                                                           |
| Anthropic                         | AI modules (S8/S10/S11), post-ADR-0004/A5                             | Gates L-track real-PHI AI only, not R6 · weeks                                                                      |
| Minduo ↔ Handal                   | Minduo processes Handal's PHI as a business associate (B7)            | Gates R6 · days (template + signatures)                                                                             |

Never on this list: **Stripe** — signs no BAA; PHI never reaches it (constitution invariant).

## Other paperwork (non-BAA)

| Item                                                                | Why                                                         | When it gates · lead time                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| TCPA/consent counsel review (B3 templates + STOP flow)              | Outbound texting to patients; verify the relationship basis | Before R6 sends · days                                                  |
| 10DLC brand + campaign registration (toll-free = the fast fallback) | Carrier sender registration; healthcare draws extra vetting | Gates R6; starts only after the B4 pick · days–4 weeks                  |
| DoseSpot enrollment + DEA EPCS identity proofing (IAL3)             | E-prescribing                                               | Phase H, pullable forward — hence the R0 start · months, uncompressible |
| Apple Developer enrollment                                          | Mobile, later                                               | L-track mobile · days–weeks                                             |

## Review log

- 2026-08-13 — Created (Alec's division-of-labor decision), consolidating V1_PROPOSAL §7's
  clock table as the single queue. Nothing signed yet; all clocks running except 10DLC
  (blocked on B4).
