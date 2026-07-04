/**
 * Non-PHI UI preference flags shared between server layout (cookie read for a
 * flash-free first paint) and client shell (cookie write on toggle). Plain module —
 * a constant exported from a "use client" file reaches RSC as a client-reference
 * proxy, not a string.
 *
 * Distinct from the portal's cookie name: in local dev both apps run on localhost
 * (different ports share one cookie jar), and staff/patient preferences must not
 * fight each other.
 */
export const COLLAPSE_COOKIE = "medibun_staff_sidebar";
