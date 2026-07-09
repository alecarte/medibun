/**
 * Privacy glance mask (S5b): masks patient names to initials for walk-behind moments
 * at a shared workstation. Incidental-disclosure mitigation, NOT auth — the session
 * stays valid; unmasking is one tap/keypress (decided 2026-07-06; re-auth-to-unmask
 * arrives with the post-v0 real-staff hardening, see docs/AUTH.md).
 */

/** Idle time before the mask auto-engages (the HIPAA addressable-safeguard alignment). */
export const IDLE_MASK_MS = 2 * 60_000;

/** Background refetch cadence for the live-updating schedule (S5b). */
export const POLL_INTERVAL_MS = 15_000;

/** "Synthia Loginsmith" → "S. L." — one initial per name part, never an empty mask. */
export function maskName(name: string): string {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part[0]!}.`);
  return initials.length > 0 ? initials.join(" ") : "•";
}

/** A masked contact/detail value: "Hidden" while the mask is on (never the value);
 *  the value otherwise; a missing value stays missing (its honest em dash is the
 *  caller's). THE one place the mask's replacement text lives — the detail card and
 *  the move-up panel must never drift apart on it. */
export function maskValue(masked: boolean, value: string | undefined): string | undefined {
  return masked && value ? "Hidden" : value;
}
