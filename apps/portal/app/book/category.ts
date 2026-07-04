import type { ServiceColor } from "@medibun/api-client";

/**
 * Categorical service color → Tailwind utility, written out literally so Tailwind's
 * scanner sees every class (dynamic `bg-category-${c}-text` would never be generated).
 * Token source: design-tokens color.category.* (S3).
 */
export const CATEGORY_DOT: Record<ServiceColor, string> = {
  sage: "bg-category-sage-text",
  teal: "bg-category-teal-text",
  indigo: "bg-category-indigo-text",
  plum: "bg-category-plum-text",
  clay: "bg-category-clay-text",
  slate: "bg-category-slate-text",
};

/** Card media panel tint — the photography-ready area until real brand assets land. */
export const CATEGORY_WASH: Record<ServiceColor, string> = {
  sage: "bg-category-sage-wash",
  teal: "bg-category-teal-wash",
  indigo: "bg-category-indigo-wash",
  plum: "bg-category-plum-wash",
  clay: "bg-category-clay-wash",
  slate: "bg-category-slate-wash",
};

/** Saturated text color per category (also the avatar initials color). */
export const CATEGORY_TEXT: Record<ServiceColor, string> = {
  sage: "text-category-sage-text",
  teal: "text-category-teal-text",
  indigo: "text-category-indigo-text",
  plum: "text-category-plum-text",
  clay: "text-category-clay-text",
  slate: "text-category-slate-text",
};
