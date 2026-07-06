import { createApiClient, SESSION_COOKIE_NAME } from "@medibun/api-client";
import { cookies } from "next/headers";

/**
 * Server-side BFF access, in one place: the base-URL decision and the
 * forward-ONLY-the-session-cookie policy (data minimization, security.md) are
 * defined here and nowhere else. RSC-only (uses next/headers).
 * Twin of apps/staff/app/lib/bff.ts — the apps deploy separately, so the file is
 * duplicated by design; change both together.
 */

/** The forwardable session cookie header, or undefined when signed out. */
export async function sessionCookie(): Promise<string | undefined> {
  const session = (await cookies()).get(SESSION_COOKIE_NAME);
  return session && `${SESSION_COOKIE_NAME}=${session.value}`;
}

/** A client pointed at the BFF (server-side: direct, not the browser /api proxy). */
export function bffClient() {
  return createApiClient({ baseUrl: process.env.API_BASE_URL ?? "http://localhost:3001" });
}
