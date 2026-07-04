/**
 * Practice-authored pre-arrival content, keyed by service code (synthetic placeholder
 * copy until practice content management lands — BOOKING_DESIGN.md §3). Review fix:
 * prep guidance must be per-service; injectable advice on a consult/facial booking
 * would be factually wrong clinical-adjacent instruction.
 */

const INJECTABLE_PREP = ["Skip alcohol and blood thinners for 24 hours before your visit."];

const PREP_NOTES: Record<string, readonly string[]> = {
  "svc-botox": INJECTABLE_PREP,
  "svc-dysport": INJECTABLE_PREP,
  "svc-lip-filler": INJECTABLE_PREP,
};

/** Every visit gets the arrival ritual; service-specific prep only where authored. */
export function prepNotes(serviceCode: string): readonly string[] {
  return [
    ...(PREP_NOTES[serviceCode] ?? []),
    "Arrive 10 minutes early — check in at the front desk.",
  ];
}
