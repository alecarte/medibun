import { createApiClient, type PatientProfile } from "@medibun/api-client";
import { cookies } from "next/headers";

/**
 * Server-side session read: forwards the incoming HttpOnly session cookie to the BFF
 * and resolves the signed-in patient's profile, or undefined when signed out. RSC-only
 * (uses next/headers). The browser never handles the cookie value itself.
 */
export async function getSessionProfile(): Promise<PatientProfile | undefined> {
  // Forward ONLY the session cookie (data minimization, security.md) — never the
  // whole cookie header.
  const session = (await cookies()).get("medibun_session");
  if (!session) {
    return undefined;
  }
  const client = createApiClient({
    baseUrl: process.env.API_BASE_URL ?? "http://localhost:3001",
  });
  return client.getMyProfile({ cookie: `medibun_session=${session.value}` });
}
