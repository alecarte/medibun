# visual-check

The screenshot-review harness behind DESIGN.md tenet 5 ("no slice ships without its screens
being screenshot-reviewed"). It exists so any session — human or Claude, laptop or remote
container — can look at the real rendered UI without standing up Docker/Medplum.

Deliberately **not** a workspace package: it never ships, never gates CI, and shouldn't add a
browser dependency to the product graph. Install its one dep here, on demand.

## Pieces

- `stub-bff.mjs` — a ~100-line stand-in for `apps/api` on port 3001, speaking the real
  `docs/API.md` shapes with synthetic data (mirrors the demo seed). Any session cookie counts
  as signed in; `POST /stub/fail-next-book` makes the next booking 409 (slot-taken UX).
  Update it when the API contract changes — it is part of keeping docs/API.md honest.
- `browser.mjs` — Chromium resolution (env `VISUAL_CHECK_CHROMIUM` → Playwright-managed
  install → system Chrome). playwright-core downloads no browser.
- `shoot.mjs` — one-shot screenshots for static states. Flows that need clicks (collapse the
  sidebar, pick a slot, book) get a short bespoke script using `launch()` from `browser.mjs` —
  write it next to these, run it, delete it or keep it if it'll recur.

## Recipe

```bash
cd tools/visual-check && npm install                     # once per machine/container
node stub-bff.mjs &                                      # BFF stand-in on :3001
pnpm --filter @medibun/portal dev &                      # portal on :3100 (talks to :3001)
node shoot.mjs http://localhost:3100/book book.png 390x844 --signed-in
# staff app (S5): dev server on :3200, day sheet at / — review at 1280x800 AND tablet width
pnpm --filter @medibun/staff dev &
node shoot.mjs http://localhost:3200/ staff-today.png 1280x800 --signed-in
```

Then actually LOOK at the output (Claude: Read the PNG). Screenshot review means comparing
against the spec (BOOKING_DESIGN.md §3, DESIGN.md tenets) at both 1280×800 and 390×844 —
mobile-first is binding (DESIGN.md tenet 7). Kill the background servers when done.

Real-stack verification (live Medplum, real $book) is a different activity — see the
live-verify checklists in `docs/V0_PROPOSAL.md` §9.
