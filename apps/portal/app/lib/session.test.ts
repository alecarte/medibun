import { describe, it, expect, vi, beforeEach } from "vitest";

const cookieStore = { get: vi.fn() };
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve(cookieStore) }));

// react.cache memoizes per request; in tests we want each call fresh.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: <T>(fn: T) => fn };
});

import { getSessionProfile } from "./session";

function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  return calls;
}

describe("getSessionProfile", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    cookieStore.get.mockReset();
  });

  it("resolves undefined without any network call when no session cookie exists", async () => {
    cookieStore.get.mockReturnValue(undefined);
    const calls = stubFetch(200, {});
    await expect(getSessionProfile()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("forwards ONLY the session cookie and resolves the profile", async () => {
    cookieStore.get.mockReturnValue({ value: "abc" });
    const calls = stubFetch(200, { id: "p1", name: "Synthia Loginsmith" });
    await expect(getSessionProfile()).resolves.toEqual({ id: "p1", name: "Synthia Loginsmith" });
    expect(new Headers(calls[0]!.init?.headers).get("cookie")).toBe("medibun_session=abc");
  });

  it("reads 401 and 404 as signed out (benign states)", async () => {
    cookieStore.get.mockReturnValue({ value: "abc" });
    stubFetch(401, { error: "unauthenticated" });
    await expect(getSessionProfile()).resolves.toBeUndefined();
    stubFetch(404, { error: "not_found" });
    await expect(getSessionProfile()).resolves.toBeUndefined();
  });

  it("NEVER throws — a failing BFF reads as signed out (root layout must not crash)", async () => {
    cookieStore.get.mockReturnValue({ value: "abc" });
    stubFetch(500, { error: "internal_error" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(getSessionProfile()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0]![0])).not.toContain("abc");
    spy.mockRestore();
  });
});
