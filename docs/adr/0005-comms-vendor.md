# ADR-0005: Comms vendors — Twilio for SMS; SendGrid-under-Twilio-BAA for email, Mailgun fallback

- **Status:** Accepted (Alec, 2026-08-13 — as recommended below)
- **Date:** 2026-08-13
- **Gate:** B4 (`V1_PROPOSAL.md` §6) — comms vendor ADR + PHI-touching dependency approval

## Context

R3 builds the comms boundary: one choke-point module, the only place vendor SDKs are imported,
sending SMS (cadence-led) and email (one touch per default dormant cadence) under the B3
messaging standard. Bodies are PHI-minimal by rule (first name + practice name + one opaque
link), but the recipient's phone/email **associated with the practice** is still PHI — so both
channels require a signed BAA before any real send (`BAA_CHECKLIST.md` release rule).

B4 is schedule-critical for one reason: the **10DLC carrier registration clock starts only at
the vendor pick**, and it gates R6 sends. Evaluation criteria fixed at approval (V1 §12):
BAA availability, pricing, STOP-handling webhooks, 10DLC registration lead time.

At engagement-zero volume (a dormant pool of hundreds, ≤4 touches each — low thousands of
messages) unit pricing is immaterial; the deciding criteria are BAA terms, opt-out mechanics,
and registration lead time.

## Evaluation (researched 2026-08-13)

### SMS

**Twilio — recommended.** Signs a BAA (Business Associate Addendum to its ToS) covering its
HIPAA-eligible services, which explicitly include Programmable Messaging/SMS, MMS, and message
scheduling. Carrier-level STOP/opt-out keyword handling is built in, with inbound-message and
delivery-status webhooks for the sequencer's ledger (`touches` timestamps) and STOP
transitions. 10DLC brand + campaign registration runs through Twilio's Trust Hub — the most
worn path in the industry. Indicative pricing (immaterial at our volume): ~$0.008/SMS +
carrier fees + ~$1.15/mo per number + one-time brand/campaign registration and small monthly
campaign fees.

Alternatives (Telnyx, Vonage) also offer BAAs but bring no advantage that offsets Twilio's
maturity on exactly our four criteria; not pursued further.

### Email

- **Postmark — disqualified.** States outright it is not HIPAA compliant and will not sign a
  BAA. (This kills the original V1 "Twilio + Postmark" pairing.)
- **Resend — disqualified** (no BAA; already recorded in `BAA_CHECKLIST.md`).
- **SendGrid (Twilio) — recommended, conditionally.** Not HIPAA-eligible on self-serve plans;
  Twilio's own docs say HIPAA workflows require a BAA executed **through Twilio's
  enterprise/sales process**. The draw: one vendor relationship and one BAA negotiation
  covering both channels. The risk: enterprise sales lead time / minimum-commitment terms are
  unknown until asked.
- **Mailgun — the fallback.** Signs BAAs (higher-tier plans), SOC 2 + HIPAA reports,
  event webhooks for delivery/bounce/complaint. A known, self-contained path if the SendGrid
  enterprise conversation stalls or its terms are out of proportion for one practice's volume.
- **AWS SES — not recommended.** HIPAA-eligible under an AWS BAA, but we have no other AWS
  footprint (Vercel + Neon stack); adding an entire AWS account + BAA relationship for one
  email touch per cadence is the wrong trade.

### 10DLC / carrier registration (the clock B4 starts)

Current industry timelines: brand registration 1–5 business days; standard campaign approval
1–4 weeks (~2 weeks average); healthcare draws enhanced vetting, up to ~10 additional business
days. **Correction to `BAA_CHECKLIST.md`:** toll-free verification currently runs **4–6
weeks — slower than 10DLC (~2–3 weeks)** — so toll-free is no longer the fast fallback; 10DLC
on a local number is both the faster and the better-deliverability path.

## Decision

Accepted as recommended (Alec, 2026-08-13):

1. **SMS: Twilio.** Start the Twilio BAA immediately; register the 10DLC brand + healthcare
   campaign the same week (the schedule-critical clock).
2. **Email: open the SendGrid question inside the same Twilio BAA conversation.** If SendGrid
   can ride the same BAA on sane terms, one vendor covers both channels. If not, **Mailgun**
   with its own BAA — email is one touch in an SMS-led cadence and is not on the R6 critical
   path, so the fallback costs nothing now.

## Consequences

- The comms module (R3) is written against our own interface; vendor SDKs are imported only
  inside it (lint-enforced), so the SendGrid-vs-Mailgun outcome changes an adapter, not the
  design. Live sends stay stubbed until the relevant BAA is signed (synthetic-only rule, R3).
- `BAA_CHECKLIST.md` rows to update at the pick: SMS vendor → Twilio (clock running), email
  vendor → SendGrid-or-Mailgun (clock running), 10DLC row → clock started, toll-free note
  corrected.
- TCPA/consent counsel review (already queued) proceeds against Twilio's STOP semantics.

## Sources

- Twilio: [Twilio and HIPAA](https://www.twilio.com/en-us/hipaa) ·
  [Understanding Twilio's BAA](https://www.twilio.com/en-us/blog/understanding-twilio-baa) ·
  [Programmable Voice, SIP, and SMS HIPAA-eligible](https://www.twilio.com/en-us/changelog/programmable-voice--sip--and-sms-are-now-hipaa-eligible)
- SendGrid: [Is SendGrid HIPAA Compliant? (Twilio docs)](https://www.twilio.com/docs/sendgrid/ui/account-and-settings/hipaa-compliant) ·
  [SendGrid support: HIPAA](https://support.sendgrid.com/hc/en-us/articles/360041790233-Is-Twilio-SendGrid-HIPAA-Compliant) ·
  [Paubox: Is Twilio SendGrid HIPAA compliant? (2026)](https://www.paubox.com/blog/twilio-sendgrid-hipaa-compliant)
- Postmark: [Postmark support: Is Postmark HIPAA Compliant?](https://postmarkapp.com/support/article/1041-is-postmark-hipaa-compliant) ·
  [HIPAA Journal on Postmark](https://www.hipaajournal.com/postmark-hipaa-compliant/)
- Mailgun / SES: [Mailtrap: SMTP providers compliance comparison (2026)](https://mailtrap.io/blog/smtp-providers-compliance-comparison/) ·
  [Paubox: HIPAA-compliant alternatives to Amazon SES](https://www.paubox.com/blog/hipaa-compliant-alternatives-to-amazon-ses-for-sending-phi)
- 10DLC / toll-free timelines: [TxtImpact 10DLC registration guide (2026)](https://www.txtimpact.com/blog/a2p-10dlc-registration-guide) ·
  [Telgorithm: toll-free vs 10DLC](https://www.telgorithm.com/news/toll-free-vs-10dlc) ·
  [Fransis: 10DLC for healthcare organizations](https://www.fransis.ai/articles/10dlc-registration-guide-2026)
