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
