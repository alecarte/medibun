---
name: visual-check
description: Screenshot-review a portal or staff UI change against the design spec, using the stub BFF + Playwright harness in tools/visual-check. Use before calling any UI slice done (DESIGN.md tenet 5), and whenever asked to "look at", verify, or screenshot the UI.
---

# Visual check

Every UI change gets looked at in a real browser before it's done — jsdom tests can't see
judder, clipping, contrast, or layout. The harness lives in `tools/visual-check/` (its README
is the source of truth; keep it working).

1. `cd tools/visual-check && npm install` (once per container), then start `node stub-bff.mjs`
   and the app under review (`pnpm --filter @medibun/portal dev`, staff needs no stub) in the
   background.
2. Capture the states the change touches. Static states: `shoot.mjs`. Interactive flows
   (collapse, slot pick, booking, drawer): write a short bespoke playwright-core script using
   `launch()` from `browser.mjs` — retry clicks until hydration takes them (assert an
   aria-state flipped), and grab a mid-transition frame when reviewing animation.
3. **Read every screenshot** and compare against the spec: BOOKING_DESIGN.md §3 for booking,
   DESIGN.md tenets otherwise. Always shoot BOTH 1280×800 and 390×844 — mobile-first is
   binding (tenet 7). Check empty/error states if the change touches them.
4. Fix what looks wrong, re-shoot, then kill the background servers.

If the API contract changed this slice, update `stub-bff.mjs` to match docs/API.md first —
a stale stub reviews the wrong UI.
