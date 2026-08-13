# BAA checklist

Everywhere the current stack needs a signed BAA before real PHI touches it, on one screen.
**Owner: Alec** — admin/business paperwork is his queue (decided 2026-08-13); sessions build
against local/stub services and don't chase these. Timing clocks and detail:
[`V1_PROPOSAL.md`](V1_PROPOSAL.md) §7. Until a row is signed, the real-PHI runbook governs
(`.claude/rules/security.md`): real data stays on practice-controlled hardware.

| Service                                  | Why it needs a BAA                                                    | Status                                                 |
| ---------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| Medplum Cloud                            | Clinical source of truth — holds all PHI                              | Needed before prod PHI                                 |
| Vercel (Pro + HIPAA)                     | Hosts the BFF + web apps; PHI transits it                             | Needed before prod PHI                                 |
| Neon (Scale plan, ADR-0002)              | Experience DB; recovery staging holds patient identity + contact info | Needed before cloud promotion of real data             |
| SMS vendor (B4 pick pending; ADR-0005)   | Outbound texts to patient phone numbers                               | BAA + 10DLC registration before any real send          |
| Email vendor (B4 pick pending; ADR-0005) | Outbound email to patients                                            | BAA before any real send; Resend disqualified (no BAA) |
| Sentry                                   | Error monitoring on the prod stack (PHI-scrubbed by design)           | BAA before wiring into prod                            |
| PostHog                                  | Product analytics (no PHI by design)                                  | BAA before wiring into prod                            |
| Anthropic                                | AI modules (S8/S10/S11), post-ADR-0004/A5                             | BAA before any PHI in a prompt                         |
| Minduo ↔ Handal                          | Business-associate agreement between the operating entity + practice  | Practice-side paperwork (B7)                           |

Never on this list: **Stripe** — signs no BAA; PHI never reaches it (constitution invariant).

When a BAA lands, flip its row here and record any real-data cut-over in
[`RECOVERY_DESIGN.md`](RECOVERY_DESIGN.md)'s review log (its §7 rule).
