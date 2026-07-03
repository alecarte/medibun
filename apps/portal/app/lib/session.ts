import { createApiClient, SESSION_COOKIE_NAME, type PatientProfile } from "@medibun/api-client";
import { cookies } from "next/headers";
import { cache } from "react";

/**
 * Server-side session read: forwards the incoming HttpOnly session cookie to the BFF
 * and resolves the signed-in patient's profile, or undefined when signed out. RSC-only
 * (uses next/headers). The browser never handles the cookie value itself.
 *
 * Wrapped in React cache(): the layout (sidebar) and pages both call this, and per-request
 * memoization collapses them into ONE BFF round trip per render (review, 2026-07-02).
 *
 * NEVER throws: this runs in the root layout, so an exception here would take down every
 * route — including /login, the recovery path. Any failure reads as signed-out; pages that
 * need a profile redirect to /login and the user can re-authenticate.
 */
export const getSessionProfile = cache(async (): Promise<PatientProfile | undefined> => {
  // Forward ONLY the session cookie (data minimization, security.md) — never the
  // whole cookie header.
  const session = (await cookies()).get(SESSION_COOKIE_NAME);
  if (!session) {
    return undefined;
  }
  const client = createApiClient({
    baseUrl: process.env.API_BASE_URL ?? "http://localhost:3001",
  });
  try {
    return await client.getMyProfile({ cookie: `${SESSION_COOKIE_NAME}=${session.value}` });
  } catch {
    // Identifier-free by design: no session value, no profile data in logs.
    console.error(JSON.stringify({ msg: "session probe failed; treating as signed out" }));
    return undefined;
  }
});
