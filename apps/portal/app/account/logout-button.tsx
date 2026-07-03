"use client";

import { createApiClient } from "@medibun/api-client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    try {
      // Same-origin /api proxy; the BFF revokes the session and clears the cookie.
      await createApiClient({ baseUrl: "/api" }).logout();
    } catch {
      // Never strand the user on a failed logout call — navigate home regardless;
      // the refreshed render reflects the actual session state (review, 2026-07-02).
    } finally {
      router.push("/");
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="rounded-control border border-border-interactive px-4 py-2 text-sm font-medium text-text-primary disabled:opacity-60"
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
