import {
  BookingError,
  createApiClient,
  SESSION_COOKIE_NAME,
  type ServiceAvailability,
  type ServiceSummary,
} from "@medibun/api-client";
import { cookies } from "next/headers";
import { cache } from "react";

/**
 * Server-side booking reads (RSC-only, uses next/headers): forward the session cookie
 * to the BFF like lib/session.ts. Failures resolve to error sentinels rather than
 * throwing — the booking pages render designed error states (DESIGN.md tenet 5),
 * never a default crash page.
 */

async function sessionCookie(): Promise<string | undefined> {
  const session = (await cookies()).get(SESSION_COOKIE_NAME);
  return session && `${SESSION_COOKIE_NAME}=${session.value}`;
}

const bffClient = () =>
  createApiClient({ baseUrl: process.env.API_BASE_URL ?? "http://localhost:3001" });

/** The bookable service menu, or undefined when the BFF read fails. Per-render cached. */
export const getServices = cache(async (): Promise<ServiceSummary[] | undefined> => {
  const cookie = await sessionCookie();
  if (!cookie) {
    return undefined;
  }
  try {
    return await bffClient().listServices({ cookie });
  } catch {
    // Identifier-free by design (security.md): no session value, no response data.
    console.error(JSON.stringify({ msg: "service menu read failed" }));
    return undefined;
  }
});

/** Availability for one service; "not_found" for an unknown code, undefined on failure. */
export const getAvailability = cache(
  async (serviceCode: string): Promise<ServiceAvailability | "not_found" | undefined> => {
    const cookie = await sessionCookie();
    if (!cookie) {
      return undefined;
    }
    try {
      return await bffClient().getAvailability(serviceCode, { cookie });
    } catch (err) {
      if (err instanceof BookingError && err.code === "not_found") {
        return "not_found";
      }
      console.error(JSON.stringify({ msg: "availability read failed" }));
      return undefined;
    }
  },
);
