/**
 * Shared UI-preference cookie names. Plain module (no "use client") so BOTH the server
 * layout and client components import the real string — a constant exported from a
 * client module reaches RSC as a client-reference proxy, not its value.
 * Non-PHI flags only — never session or patient data (security.md).
 */
export const COLLAPSE_COOKIE = "medibun_sidebar";
