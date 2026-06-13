import { describe, expect, it } from "vitest";

import {
  directUserLogin,
  refreshUserTokens,
  InvalidCredentialsError,
  MfaRequiredError,
  MultipleMembershipsError,
} from "./user-login.js";

const config = {
  baseUrl: "http://medplum.test/",
  clientId: "client-1",
  clientSecret: "secret-1",
};

const projectId = "project-aureva";

type Call = { url: string; init: RequestInit };

function sequencedFetch(responses: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses[calls.length - 1] ?? { status: 500, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetchImpl, calls };
}

describe("directUserLogin", () => {
  const happyPath = [
    { status: 200, body: { login: "login-123", code: "code-abc" } },
    { status: 200, body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } },
    { status: 200, body: { profile: { resourceType: "Patient", id: "p-1" } } },
  ];

  it("logs in, exchanges the code, resolves the profile, and returns the session material", async () => {
    const { fetchImpl, calls } = sequencedFetch(happyPath);
    const result = await directUserLogin(config, projectId, "synth@example.test", "pw", fetchImpl);

    expect(result).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresIn: 3600,
      loginId: "login-123",
      profileReference: "Patient/p-1",
    });

    expect(calls[0]!.url).toBe("http://medplum.test/auth/login");
    const loginBody = JSON.parse(String(calls[0]!.init.body)) as Record<string, string>;
    expect(loginBody.email).toBe("synth@example.test");
    expect(loginBody.codeChallengeMethod).toBe("S256");
    expect(loginBody.codeChallenge).toBeTruthy();
    expect(loginBody.scope).toContain("offline_access");
    // projectId scopes membership selection (single membership auto-binds → code);
    // clientId binds the Login to our client so a refresh token is issued at exchange.
    expect(loginBody.projectId).toBe(projectId);
    expect(loginBody.clientId).toBe("client-1");

    expect(calls[1]!.url).toBe("http://medplum.test/oauth2/token");
    const tokenBody = String(calls[1]!.init.body);
    expect(tokenBody).toContain("grant_type=authorization_code");
    expect(tokenBody).toContain("code=code-abc");
    expect(tokenBody).toContain("code_verifier=");
    expect(tokenBody).toContain("client_id=client-1");
    // PKCE exchange must NOT send the client secret (Medplum rejects it → 500).
    expect(tokenBody).not.toContain("client_secret");

    expect(calls[2]!.url).toBe("http://medplum.test/auth/me");
  });

  it("throws InvalidCredentialsError on a 400 from auth/login", async () => {
    const { fetchImpl } = sequencedFetch([{ status: 400, body: { issue: [] } }]);
    await expect(
      directUserLogin(config, projectId, "synth@example.test", "wrong", fetchImpl),
    ).rejects.toThrow(InvalidCredentialsError);
  });

  it("throws InvalidCredentialsError on a 401 from auth/login", async () => {
    const { fetchImpl } = sequencedFetch([{ status: 401, body: { issue: [] } }]);
    await expect(
      directUserLogin(config, projectId, "synth@example.test", "wrong", fetchImpl),
    ).rejects.toThrow(InvalidCredentialsError);
  });

  it("maps Medplum's upstream 429 to InvalidCredentialsError (its login throttle, not a server fault)", async () => {
    const { fetchImpl } = sequencedFetch([{ status: 429, body: { issue: [] } }]);
    await expect(
      directUserLogin(config, projectId, "synth@example.test", "pw", fetchImpl),
    ).rejects.toThrow(InvalidCredentialsError);
  });

  it("throws MfaRequiredError when the login needs an MFA step (no code yet)", async () => {
    const { fetchImpl } = sequencedFetch([
      { status: 200, body: { login: "l-1", mfaRequired: true } },
    ]);
    await expect(
      directUserLogin(config, projectId, "staff@example.test", "pw", fetchImpl),
    ).rejects.toThrow(MfaRequiredError);
  });

  it("throws MfaRequiredError when MFA enrollment is required", async () => {
    const { fetchImpl } = sequencedFetch([
      { status: 200, body: { login: "l-1", mfaEnrollRequired: true, enrollUri: "otpauth://x" } },
    ]);
    await expect(
      directUserLogin(config, projectId, "staff@example.test", "pw", fetchImpl),
    ).rejects.toThrow(MfaRequiredError);
  });

  it("throws MultipleMembershipsError when the login returns unresolved memberships", async () => {
    const { fetchImpl } = sequencedFetch([
      { status: 200, body: { login: "l-1", memberships: [{ id: "m-1" }, { id: "m-2" }] } },
    ]);
    await expect(
      directUserLogin(config, projectId, "multi@example.test", "pw", fetchImpl),
    ).rejects.toThrow(MultipleMembershipsError);
  });

  it("never includes the email or upstream body in non-credential errors", async () => {
    const { fetchImpl } = sequencedFetch([
      { status: 200, body: { login: "login-123", code: "code-abc" } },
      { status: 500, body: { secret: "upstream-detail" } },
    ]);
    const err = await directUserLogin(
      config,
      projectId,
      "synth@example.test",
      "pw",
      fetchImpl,
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("synth@example.test");
    expect((err as Error).message).not.toContain("upstream-detail");
    expect((err as Error).message).toContain("500");
  });
});

describe("refreshUserTokens", () => {
  it("exchanges a refresh token for new tokens", async () => {
    const { fetchImpl, calls } = sequencedFetch([
      { status: 200, body: { access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 } },
    ]);
    await expect(refreshUserTokens(config, "rt-1", fetchImpl)).resolves.toEqual({
      accessToken: "at-2",
      refreshToken: "rt-2",
      expiresIn: 3600,
    });
    expect(calls[0]!.url).toBe("http://medplum.test/oauth2/token");
    expect(String(calls[0]!.init.body)).toContain("grant_type=refresh_token");
  });
});
