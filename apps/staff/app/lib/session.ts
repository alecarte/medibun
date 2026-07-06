import type { StaffProfile } from "@medibun/api-client";
import { cache } from "react";

import { bffClient, sessionCookie } from "./bff";

/**
 * Server-side session read: forwards the incoming HttpOnly session cookie to the BFF
 * and resolves the signed-in STAFF member's profile, or undefined when signed out (or
 * when the session belongs to a non-staff principal — the BFF answers 404 for those).
 *
 * Wrapped in React cache() so the layout (sidebar) and pages collapse into ONE BFF
 * round trip per render. NEVER throws: it runs in the root layout, and /login must
 * stay reachable when the BFF is down — any failure reads as signed out.
 */
export const getSessionStaff = cache(async (): Promise<StaffProfile | undefined> => {
  const cookie = await sessionCookie();
  if (!cookie) {
    return undefined;
  }
  try {
    return await bffClient().getStaffProfile({ cookie });
  } catch {
    // Identifier-free by design: no session value, no profile data in logs.
    console.error(JSON.stringify({ msg: "staff session probe failed; treating as signed out" }));
    return undefined;
  }
});
