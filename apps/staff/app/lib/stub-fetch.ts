import { vi } from "vitest";

/**
 * Test-only helper (imported exclusively from *.test files — never bundled):
 * stub global fetch with one canned JSON response and record every request.
 */
export function stubFetch(status: number, body: unknown) {
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
