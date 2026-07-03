import { BookingError, type ServiceAvailability, type ServiceSummary } from "@medibun/api-client";
import { cache } from "react";

import { bffClient, sessionCookie } from "./bff";

/**
 * Server-side booking reads (RSC-only). Failures resolve to error sentinels rather
 * than throwing — the booking pages render designed error states (DESIGN.md tenet 5),
 * never a default crash page.
 */

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
