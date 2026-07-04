# @medibun/design-tokens

The **single source of truth for theming** (binding — CLAUDE.md). DTCG token JSON compiled by
Style Dictionary into every platform's format: web CSS variables + Tailwind `@theme`, the mobile
restyle theme, and a typed `tokens` object.

- Brand values (colors, logos, `brand-name`) are **runtime-configurable** — web via
  `[data-brand]` CSS scopes, mobile via the restyle `ThemeProvider`. Never hardcode a brand
  value in an app; if you're typing a hex color outside this package, stop.
- `src/tokens.generated.ts` and `dist/` are regenerated on `build` — don't hand-edit.
- Contrast is a **test**: the WCAG AA contract tests fail the build if a palette change breaks
  readable pairings. Categorical service colors (`CategoryColor`) live here too.

```bash
pnpm --filter @medibun/design-tokens build   # regenerate outputs from the DTCG source
pnpm --filter @medibun/design-tokens test    # incl. AA contrast + output-shape contracts
```
