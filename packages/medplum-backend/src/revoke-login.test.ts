import type { Login } from "@medplum/fhirtypes";
import { describe, expect, it } from "vitest";

import { revokeLoginById, type LoginRevoker } from "./revoke-login.js";

function synthLogin(revoked: boolean): Login {
  return {
    resourceType: "Login",
    id: "login-1",
    user: { reference: "User/u-1" },
    authMethod: "password",
    authTime: "2026-06-12T00:00:00Z",
    revoked,
  };
}

describe("revokeLoginById", () => {
  it("marks the Login resource revoked via the service client", async () => {
    const updates: Login[] = [];
    const client: LoginRevoker = {
      readResource: () => Promise.resolve(synthLogin(false)),
      updateResource: (resource: Login) => {
        updates.push(resource);
        return Promise.resolve(resource);
      },
    };
    await revokeLoginById(client, "login-1");
    expect(updates).toEqual([{ ...synthLogin(false), revoked: true }]);
  });

  it("is a no-op when the Login is already revoked", async () => {
    const updates: Login[] = [];
    const client: LoginRevoker = {
      readResource: () => Promise.resolve(synthLogin(true)),
      updateResource: (resource: Login) => {
        updates.push(resource);
        return Promise.resolve(resource);
      },
    };
    await revokeLoginById(client, "login-1");
    expect(updates).toEqual([]);
  });
});
