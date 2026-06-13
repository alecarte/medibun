import { createHash, randomBytes } from "node:crypto";

import type { MedplumBackendConfig } from "./client.js";

/**
 * Medplum direct-login API, brokered by the BFF (docs/AUTH.md, accepted 2026-06-11).
 *
 * PASSWORD TRANSIT RULE (hard): the password parameter is forwarded to Medplum over
 * TLS and discarded — never logged, never stored, never echoed in errors. Errors
 * thrown here carry status codes only, no request/response bodies.
 */

export type UserTokens = {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Seconds until the access token expires. */
  readonly expiresIn: number;
  readonly loginId: string;
  /** e.g. "Patient/abc" or "Practitioner/xyz". */
  readonly profileReference: string;
};

export type RefreshedTokens = {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn: number;
};

export class InvalidCredentialsError extends Error {
  constructor() {
    super("invalid credentials");
    this.name = "InvalidCredentialsError";
  }
}

/**
 * Medplum's /auth/login returned an MFA challenge (mfaRequired / mfaEnrollRequired)
 * instead of a code. The brokered MFA verify/enroll flow is not implemented yet
 * (docs/AUTH.md — its own PR), so callers surface this as "MFA not yet supported"
 * rather than a confusing 500. Staff invites set mfaRequired, so this is expected.
 */
export class MfaRequiredError extends Error {
  constructor() {
    super("mfa step required (not yet supported)");
    this.name = "MfaRequiredError";
  }
}

/**
 * /auth/login could not auto-select a single membership and returned a list. We scope
 * by projectId so this should not happen for single-project users; it signals a user
 * with multiple memberships in the same project, which needs explicit selection (later).
 */
export class MultipleMembershipsError extends Error {
  constructor() {
    super("login requires membership selection (not yet supported)");
    this.name = "MultipleMembershipsError";
  }
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

async function tokenGrant(
  config: MedplumBackendConfig,
  params: URLSearchParams,
  fetchImpl: typeof fetch,
  opts: { withSecret: boolean },
): Promise<RefreshedTokens> {
  params.set("client_id", config.clientId);
  // The PKCE authorization_code grant is authenticated by code_verifier; sending
  // client_secret alongside it makes Medplum's token endpoint reject the request
  // (invalid_request → a 500 at the BFF). The refresh_token grant uses the secret.
  if (opts.withSecret) {
    params.set("client_secret", config.clientSecret);
  }
  const res = await fetchImpl(`${config.baseUrl}oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    throw new Error(`medplum token exchange failed (status ${res.status})`);
  }
  const body = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    accessToken: body.access_token,
    ...(body.refresh_token !== undefined ? { refreshToken: body.refresh_token } : {}),
    expiresIn: body.expires_in,
  };
}

type LoginResponse = {
  login?: string;
  code?: string;
  mfaRequired?: boolean;
  mfaEnrollRequired?: boolean;
  memberships?: unknown[];
};

/**
 * Authenticate an end user (patient/staff) within a specific project and return their
 * session material.
 *
 * `projectId` scopes membership resolution so a single-project user's one membership
 * auto-binds and Medplum returns a code. (clientId does NOT filter memberships — only
 * projectId does.) Medplum's /auth/login is a state machine, not a one-shot: it can
 * return an MFA challenge or an unresolved membership list instead of a code. Those
 * branches throw typed errors rather than blindly destructuring a missing `code`.
 */
export async function directUserLogin(
  config: MedplumBackendConfig,
  projectId: string,
  email: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UserTokens> {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());

  const loginRes = await fetchImpl(`${config.baseUrl}auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      projectId,
      // Bind the Login to our ClientApplication: the client must resolve at the token
      // grant for a refresh token to be issued (its refreshTokenLifetime is used).
      clientId: config.clientId,
      codeChallenge,
      codeChallengeMethod: "S256",
      scope: "openid offline_access",
    }),
  });
  // 429 is Medplum's own per-IP login throttle (~5/min) — a credential problem from the
  // caller's view, not a server fault; map it like a rejected login, never a 500.
  if (loginRes.status === 400 || loginRes.status === 401 || loginRes.status === 429) {
    throw new InvalidCredentialsError();
  }
  if (!loginRes.ok) {
    throw new Error(`medplum login failed (status ${loginRes.status})`);
  }
  const body = (await loginRes.json()) as LoginResponse;
  if (body.mfaRequired === true || body.mfaEnrollRequired === true) {
    throw new MfaRequiredError();
  }
  if (body.memberships !== undefined || body.code === undefined || body.login === undefined) {
    throw new MultipleMembershipsError();
  }
  const { login, code } = body;

  const tokens = await tokenGrant(
    config,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
    }),
    fetchImpl,
    { withSecret: false },
  );

  const meRes = await fetchImpl(`${config.baseUrl}auth/me`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  if (!meRes.ok) {
    throw new Error(`medplum profile lookup failed (status ${meRes.status})`);
  }
  const me = (await meRes.json()) as { profile: { resourceType: string; id: string } };

  return {
    ...tokens,
    loginId: login,
    profileReference: `${me.profile.resourceType}/${me.profile.id}`,
  };
}

/** Exchange a rotating refresh token for fresh tokens (serialize calls per session!). */
export async function refreshUserTokens(
  config: MedplumBackendConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshedTokens> {
  return tokenGrant(
    config,
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    fetchImpl,
    { withSecret: true },
  );
}

// NOTE: there is deliberately no bearer-token `auth/logout` helper here. That path
// silently no-ops once the access token has expired, leaving the rotated refresh
// token alive. Revoke Logins BY ID via revokeLoginById (revoke-login.ts) instead.
