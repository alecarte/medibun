"use client";

import { createApiClient, LoginError, type LoginErrorCode } from "@medibun/api-client";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** Friendly, PHI-free copy per error code (DESIGN.md voice: concrete, no blame). */
const ERROR_COPY: Record<LoginErrorCode, string> = {
  invalid_credentials: "That email or password didn't match.",
  rate_limited: "Too many attempts. Wait a few minutes, then try again.",
  mfa_not_supported: "This account needs a verification step we don't support yet.",
  membership_selection_not_supported: "This account belongs to more than one practice.",
  unknown: "Something went wrong on our side. Try again.",
};

export function LoginForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(undefined);
    try {
      // Same-origin /api proxy → BFF. The session cookie is set HttpOnly by the BFF;
      // this code never sees or stores it. The password goes TLS-only to our backend
      // and is discarded there after the brokered exchange (docs/AUTH.md).
      const client = createApiClient({ baseUrl: "/api" });
      await client.login(String(form.get("email")), String(form.get("password")));
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(ERROR_COPY[err instanceof LoginError ? err.code : "unknown"]);
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-sm font-medium text-text-primary">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="rounded-control border border-border-interactive bg-surface-card px-3 py-2 text-sm text-text-primary outline-none focus:ring-2 focus:ring-action-primary focus:ring-offset-2"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-sm font-medium text-text-primary">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          aria-describedby={error ? "login-error" : undefined}
          className="rounded-control border border-border-interactive bg-surface-card px-3 py-2 text-sm text-text-primary outline-none focus:ring-2 focus:ring-action-primary focus:ring-offset-2"
        />
      </div>
      {error && (
        <p id="login-error" role="alert" className="text-sm text-status-danger-text">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-control bg-action-primary px-4 py-2 text-sm font-medium text-text-on-accent disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
