# Patient-surface distribution strategy

**Status: APPROVED (Alec, 2026-07-04).** Question asked:
should the patient side be a standalone portal, embeddable components for practice-owned sites
(Aureva's is agency-built WordPress), or should we provide website-building tools? Two
research passes (competitive landscape; embed tech + HIPAA) inform this. Citations inline;
evidence gaps in §6.

## 1. What the market actually does (researched 2026-07)

**Booking-step embeds are commoditized.** The medspa premium bar is Boulevard's "Self-Booking
Overlay" — a JS snippet that opens a branded overlay on the practice's own site, with official
WordPress/Wix/Squarespace install guides and no account required to book
(joinblvd.com/features/self-booking; support.boulevard.io …installing-the-self-booking-overlay-wordpress).
Mangomint does the same (overlay script, deliberately login-free booking —
mangomint.com/learn/faq-online-booking). Zenoti runs a hosted "Webstore" subdomain + widget +
branded app; Vagaro ships an actual WordPress plugin; Jane/GlossGenius/Aesthetic Record mostly
link out to vendor-hosted pages (Aesthetic Record charges $5/mo just for a custom booking
subdomain). Real customization is gated: Boulevard's client API + custom booking flows are
Enterprise-only.

**Nobody embeds the rest of the relationship.** Membership purchase/wallet, loyalty state,
orders, and two-way practitioner messaging universally fall off the practice's website into
either a vendor-hosted portal (off-brand) or a native app. RepeatMD raised a $50M Series A on
exactly this layer (white-label rewards/membership/commerce app for medspas, 4,000+ practices
claimed) — but delivers it as an app-download silo that doesn't do booking, with loud G2/Capterra
complaints about cost, contracts, and pressure sales. The closest architectural proof of
"embedded components + open customer API" is Mariana Tek — in boutique fitness, not medspa
(guides.marianatek.com/web-integrations; it's an iframe under a JS loader).

**Website builders cluster at the solo/launch end** (GlossGenius, Vagaro MySite, Jane Websites
at $59/mo, Moxie's built-for-you launch sites) or are acquired agencies (PatientNow → Crystal
Clear/RxMarketing). Premium practices pay agencies $10k–20k+ for custom WordPress/Webflow
builds — an ecosystem that _wants_ something beautiful to embed, and complains about clunky
booking redirects breaking brands (jaksdigital.com/blog/med-spa-website-design).

**The gap:** the full patient relationship — booking + membership/wallet + loyalty + orders +
secure messaging — as **brand-native, conversion-designed components on the practice's own
site**, HIPAA-clean on a FHIR core. No medspa vendor owns it. Boulevard owns the booking step;
RepeatMD owns app-first monetization (and its dissatisfaction proves demand); the seam between
them is open. Compliance is a second wedge: salon-grade tools (Vagaro, Fresha, GlossGenius,
Mindbody) aren't HIPAA-positioned, and Acuity's BAA famously covers only Acuity, not the
Squarespace site around it.

## 2. The hard constraints (embed tech + HIPAA research)

- **Authenticated sessions don't survive third-party iframes.** Safari ITP blocks all
  third-party cookies in cross-site iframes (webkit.org/blog/10218); Firefox partitions by
  default; only Chrome still allows them (reversal confirmed April 2025). CHIPS (partitioned
  cookies) shipped in Safari 18.4 but is young and reportedly flaky; the Storage Access API
  works but shows users a scary two-domain permission prompt. No vendor sustains cross-browser
  login inside an embed — the industry converges on: **guest flows embedded, first-party hop
  for anything authenticated** (Calendly's own fallback doctrine; Mindbody logs in on
  widgets.healcode.com; Healthie/Tebra/SimplePractice/Klara all keep authenticated portals on
  their own domains).
- **The HIPAA line on a non-BAA WordPress host** (WP Engine/GoDaddy sign no BAAs): PHI must
  never touch the host page's origin, URL bar, logs, or pixels. Post-AHA-v-Becerra (vacatur
  stands, Aug 2024), unauthenticated discovery pages are lower-risk, but authenticated-page
  tracking guidance is fully intact and pixel class-actions exceed $100M. Safe pattern, used by
  the whole compliant-embed industry: **unauthenticated discovery + capture may embed (PHI
  fields only inside an iframe to BAA-covered infrastructure); everything authenticated lives
  first-party with us.** Engineering hygiene when we do embed: `Referrer-Policy` on all portal
  responses, no PHI in iframe src/fragments, postMessage carries pixels only with verified
  origins, never wildcard.
- **Payments**: card entry happens in our context (redirect or our-origin checkout page), never
  Stripe Elements mounted into the WordPress DOM (PCI DSS 4.0 script-attestation on a page we
  don't control; Apple Pay domain registration breaks per-practice in nested iframes). Stripe
  product naming stays clinically meaningless — "Gold Membership", never a treatment name
  (existing hard rule).
- **Premium ≠ never leave the page; premium = never see the vendor.** The two acceptable moves
  at the high end: a full-viewport branded overlay (Boulevard/SevenRooms/Resy pattern), or a
  same-tab redirect to a fully themed surface (book.practicebrand.com). Inline fixed-height
  iframes are the pattern that reads as cheap (height/scroll/keyboard/deep-link failures).

## 3. The strategy (recommendation)

**Be the patient-experience layer, not the website.** Premium practices already have agencies
and WordPress/Webflow; the leveraged move is to be the thing agencies love to embed — and to
own the full relationship, not just the booking step. Do not build a website builder (crowded,
downmarket, and our first customer already has an agency-built site). Revisit only if we ever
chase the solo segment.

Phased:

1. **Now (v0) — hosted portal, brand-continuous.** Exactly what we're building. The WordPress
   site links "Book" to our portal in the same tab; runtime brand theming (design tokens,
   `data-brand`) makes the transition invisible. This is the always-works fallback every vendor
   recommends, and it's where all authenticated surfaces (account, history, messaging, wallet)
   legitimately live forever. Mobile-first is non-negotiable — the handoff lands on phones.
2. **Post-v0 — the booking overlay (Boulevard parity).** A JS snippet: full-viewport branded
   overlay iframing our booking flow on aureva.com. Guest-first (see the identity note below),
   PHI only inside our origin, no login required until commitment. This is table stakes for the
   segment and our flow is already built for it.
3. **Phase 2+ — the differentiator: embedded relationship components.** Membership join +
   wallet balance, loyalty state, orders, "message your injector" entry — as brandable
   components on the practice's site (guest-visible states embedded; one first-party hop into
   the portal/app for authenticated depth, optionally CHIPS "remember me in this embed" as
   progressive enhancement). Package as a WordPress plugin for agency ergonomics (Vagaro is the
   only incumbent with one). A branded custom domain (portal.aureva.com or book.aureva.com
   CNAME) strengthens continuity. This is the RepeatMD value prop without the app-download
   wall or the contract resentment — web-first, booking-integrated, on a compliant core.

**Architecture already fits; keep it that way.** The components consume `@medibun/api-client`
against the BFF (anti-corruption boundary unchanged), themed only by `@medibun/design-tokens`
(runtime brand swap is the whole point), self-contained per DESIGN.md tenet 7. The BFF grows
embed-aware CORS/origin config when the overlay lands — an approval-gated auth change.

**Identity implication (flag for AUTH.md, decided already in spirit):** guest-first booking
converts and is the segment norm (Boulevard: "no account creation required"; Mangomint:
deliberately login-free). Our current flow requires login before booking — acceptable for v0's
seeded-demo scope, but the guest/SMS-first identity path (AUTH.md review note, 2026-07-03)
becomes the top post-v0 auth priority because the overlay depends on it.

## 4. What this changes now

Almost nothing — that's the point of deciding it now. v0 keeps building the portal. The binding
carry-overs: mobile-first (DESIGN.md tenet 7), components stay self-contained/token-themed, no
PHI in URLs (already binding, now also the embed prerequisite), and the ⌘K/concierge, wallet,
membership seams keep their designed placements since they graduate into embeddable components
later. ROADMAP.md carries the phased items.

## 5. Explicitly rejected

- **Website builder / site templates** — wrong segment for premium, crowded at the low end,
  and it competes with the agencies we want as a channel.
- **Web-component/SDK rendering PHI directly into the WordPress DOM** — host-page scripts and
  pixels could read it; disqualified regardless of UX appeal.
- **Auth-required embedded portal in an iframe** — broken on Safari, scary SAA prompts;
  authenticated depth stays first-party.

## 6. Evidence gaps (honest)

Boulevard/Mariana Tek internal session mechanics on Safari (not publicly documented); Safari
CHIPS real-world reliability (open WebKit bug, needs device testing before we depend on it);
embedded-vs-redirect conversion numbers are secondhand/vendor-authored (hotel +37% study
uncited at source) — no medspa-specific A/B exists publicly, so our own funnel data becomes a
marketing asset; direct practitioner sentiment (Reddit) unverifiable via search; RepeatMD
revenue estimates are scraper-grade. None of these gaps block the recommendation; the first
two gate the _implementation_ of phase-2/3 embeds and get verified hands-on then.

## Review log

- 2026-07-04 — Proposed, from Alec's prompt ("figure out how the patient side should look…
  find the gap in the market… we'll just be integrating this into a WordPress site"). Two
  research passes (competitive distribution landscape; embed tech/HIPAA), synthesized here.
- 2026-07-04 — **Approved by Alec** ("I approve this new plan"). The phased strategy in §3 is
  the standing direction: hosted portal with brand continuity now, guest booking overlay
  post-v0, embedded relationship components + WP plugin as the differentiator. No website
  builder.
