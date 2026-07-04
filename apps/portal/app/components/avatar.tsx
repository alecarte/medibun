import { categoryColors } from "@medibun/design-tokens";

import { CATEGORY_TEXT, CATEGORY_WASH } from "../book/category";

/**
 * Generated avatar (V0_PROPOSAL §6 rev. 3): a deterministic initials-on-wash disc derived
 * from the display name — deliberately never a photo, so nothing PHI-shaped enters the
 * shell. Styles derive from the one categorical ramp in book/category.ts (whose literal
 * class strings keep Tailwind's scanner satisfied), so a palette change lands here free.
 */
const AVATAR_STYLES = categoryColors.map(
  (color) => `${CATEGORY_WASH[color]} ${CATEGORY_TEXT[color]}`,
);

/** Stable small hash so the same name always gets the same color. */
function hashName(name: string): number {
  let hash = 0;
  for (const ch of name) {
    hash = (hash * 31 + ch.codePointAt(0)!) % 997;
  }
  return hash;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

export function Avatar({ name }: { readonly name: string }) {
  const style = AVATAR_STYLES[hashName(name) % AVATAR_STYLES.length];
  return (
    <span
      aria-hidden
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${style}`}
    >
      {initials(name)}
    </span>
  );
}
