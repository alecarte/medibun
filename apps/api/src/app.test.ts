import type { PatientProfile } from "@medibun/api-client";
import { describe, expect, it } from "vitest";

import { createApp, type AppDeps, type LogEntry } from "./app.js";

/** Build an app with a captured log sink and a stubbed Medplum check. */
function makeApp(
  opts: {
    checkMedplum?: () => Promise<boolean>;
    getPatientProfile?: AppDeps["getPatientProfile"];
  } = {},
) {
  const logs: LogEntry[] = [];
  const app = createApp({
    log: (entry) => logs.push(entry),
    checkMedplum: opts.checkMedplum ?? (() => Promise.resolve(true)),
    getPatientProfile: opts.getPatientProfile,
  });
  return { app, logs };
}

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const { app } = makeApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("attaches a generated x-request-id response header", async () => {
    const { app } = makeApp();
    const res = await app.request("/health");
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("echoes an incoming x-request-id", async () => {
    const { app } = makeApp();
    const res = await app.request("/health", {
      headers: { "x-request-id": "test-correlation-id" },
    });
    expect(res.headers.get("x-request-id")).toBe("test-correlation-id");
  });
});

describe("request logging (PHI-safe)", () => {
  it("logs method, path, status, duration, and request id", async () => {
    const { app, logs } = makeApp();
    const res = await app.request("/health");
    expect(logs).toHaveLength(1);
    const entry = logs[0]!;
    expect(entry.method).toBe("GET");
    expect(entry.path).toBe("/health");
    expect(entry.status).toBe(200);
    expect(typeof entry.durationMs).toBe("number");
    expect(entry.requestId).toBe(res.headers.get("x-request-id"));
  });

  it("never logs the query string (query params may carry PHI)", async () => {
    const { app, logs } = makeApp();
    await app.request("/health?mrn=SYNTH-LEAK-CANARY&name=CANARY-NAME");
    expect(logs).toHaveLength(1);
    const serialized = JSON.stringify(logs[0]);
    expect(serialized).not.toContain("mrn");
    expect(serialized).not.toContain("SYNTH-LEAK-CANARY");
    expect(serialized).not.toContain("CANARY-NAME");
    expect(logs[0]!.path).toBe("/health");
  });
});

describe("error handling (PHI-safe)", () => {
  it("returns 404 with a generic body for unknown routes", async () => {
    const { app } = makeApp();
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("not_found");
    expect(body.requestId).toBe(res.headers.get("x-request-id"));
  });

  it("returns a generic 500 body that never leaks the error message", async () => {
    const { app } = makeApp();
    // Simulates a handler bug where a thrown error interpolates sensitive data.
    app.get("/boom", () => {
      throw new Error("SENSITIVE-PATIENT-VALUE");
    });
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("SENSITIVE-PATIENT-VALUE");
    const body = JSON.parse(text) as { error: string; requestId: string };
    expect(body.error).toBe("internal_error");
    expect(body.requestId).toBe(res.headers.get("x-request-id"));
  });
});

describe("GET /patients/:id (mounted only when a reader is wired — dev guard)", () => {
  const profile: PatientProfile = { id: "synth-1", name: "Synth Example" };

  it("is NOT mounted when no patient reader is provided (default, prod-safe)", async () => {
    const { app } = makeApp();
    const res = await app.request("/patients/synth-1");
    expect(res.status).toBe(404);
  });

  it("returns the profile DTO when wired and found", async () => {
    const { app } = makeApp({ getPatientProfile: () => Promise.resolve(profile) });
    const res = await app.request("/patients/synth-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(profile);
  });

  it("returns the generic 404 body when the patient does not exist", async () => {
    const { app } = makeApp({ getPatientProfile: () => Promise.resolve(undefined) });
    const res = await app.request("/patients/missing");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });
});

describe("GET /health/medplum", () => {
  it("reports connected when the Medplum check succeeds", async () => {
    const { app } = makeApp({ checkMedplum: () => Promise.resolve(true) });
    const res = await app.request("/health/medplum");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
  });

  it("reports 503 not-connected when the check throws, without leaking the reason", async () => {
    const { app } = makeApp({
      checkMedplum: () => Promise.reject(new Error("credentials for patient X invalid")),
    });
    const res = await app.request("/health/medplum");
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain("credentials");
    expect(JSON.parse(text)).toEqual({ connected: false });
  });
});
