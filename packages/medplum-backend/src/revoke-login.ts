import type { Login } from "@medplum/fhirtypes";

/** The slice of MedplumClient this module needs (injectable for tests). */
export type LoginRevoker = {
  readResource: (resourceType: "Login", id: string) => Promise<Login>;
  updateResource: (resource: Login) => Promise<Login>;
};

/**
 * Revoke a Medplum Login by id by setting `Login.revoked` via the service account.
 *
 * Why this and not the obvious alternatives (verified against Medplum 5.1.9):
 * - Bearer `POST /oauth2/logout` only revokes the caller's CURRENT token and 401s once
 *   it expires, orphaning the rotated refresh token.
 * - `POST /auth/revoke {loginId}` is SELF-SCOPED: its handler rejects any login whose
 *   `user` != the caller's membership user (returns notFound), so a backend service
 *   account cannot use it to revoke a patient's login. (Empirically confirmed.)
 *
 * So a direct `Login.revoked` update is the only backend-driven path — but it requires
 * the service ClientApplication to have read/write AccessPolicy on the `Login` resource,
 * which is the approval-gated grant still pending (see docs/AUTH.md). Until then this
 * 403s and logout treats it as best-effort.
 */
export async function revokeLoginById(client: LoginRevoker, loginId: string): Promise<void> {
  const login = await client.readResource("Login", loginId);
  if (login.revoked === true) {
    return;
  }
  await client.updateResource({ ...login, revoked: true });
}
