/**
 * Generated avatar (V0_PROPOSAL §6 rev. 3): a deterministic initials-on-wash disc derived
 * from the display name — deliberately never a photo, so nothing PHI-shaped enters the
 * shell. Colors come from the categorical token ramp (tokens are the only visual source).
 */

const AVATAR_STYLES = [
  "bg-category-sage-wash text-category-sage-text",
  "bg-category-teal-wash text-category-teal-text",
  "bg-category-indigo-wash text-category-indigo-text",
  "bg-category-plum-wash text-category-plum-text",
  "bg-category-clay-wash text-category-clay-text",
  "bg-category-slate-wash text-category-slate-text",
] as const;

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

export function Avatar({
  name,
  size = "md",
}: {
  readonly name: string;
  readonly size?: "md" | "lg";
}) {
  const style = AVATAR_STYLES[hashName(name) % AVATAR_STYLES.length];
  const sizing = size === "lg" ? "h-12 w-12 text-base" : "h-8 w-8 text-xs";
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${sizing} ${style}`}
    >
      {initials(name)}
    </span>
  );
}
