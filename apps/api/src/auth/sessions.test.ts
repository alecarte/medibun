import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { RefreshRejectedError } from "@medibun/medplum-backend";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTokenCipher } from "./crypto.js";
import { createSessionStore, type SessionStore } from "./sessions.js";
import * as schema from "../db/schema.js";

const cipher = createTokenCipher(randomBytes(32).toString("base64"));

// Apply the REAL checked-in migration (drizzle/) so tests and prod share one schema
// definition — hand-written DDL here already drifted once (missing index).
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

const tokens = {
  profileReference: "Patient/p-1",
  loginId: "login-1",
  accessToken: "at-1",
  refreshToken: "rt-1",
  expiresIn: 3600,
};

let store: SessionStore;
let refreshCalls: string[];
let db: ReturnType<typeof drizzle>;

// One PGlite + one migration per file: booting and migrating per test blows vitest's
// hook timeout on slow CI runners. Tests are isolated by wiping rows instead.
beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
});

beforeEach(async () => {
  await db.delete(schema.sessions);
  await db.delete(schema.loginAttempts);
  refreshCalls = [];
  store = createSessionStore(db, cipher, {
    refresh: (refreshToken) => {
      refreshCalls.push(refreshToken);
      return Promise.resolve({ accessToken: "at-2", refreshToken: "rt-2", expiresIn: 3600 });
    },
  });
});

describe("session store", () => {
  it("creates a session and returns the user for it", async () => {
    const sessionId = await store.create(tokens);
    const user = await store.getUser(sessionId);
    expect(user).toEqual({ profileReference: "Patient/p-1", accessToken: "at-1" });
  });

  it("returns null for unknown or malformed session ids", async () => {
    expect(await store.getUser(crypto.randomUUID())).toBeNull();
    expect(await store.getUser("not-a-uuid")).toBeNull();
  });

  it("returns null after revocation and surfaces the login id to revoke upstream", async () => {
    const sessionId = await store.create(tokens);
    const revoked = await store.revoke(sessionId);
    expect(revoked).toEqual({ loginId: "login-1" });
    expect(await store.getUser(sessionId)).toBeNull();
  });

  it("treats an undecryptable access token as an invalid session, not an error", async () => {
    const sessionId = await store.create(tokens);
    await db
      .update(schema.sessions)
      .set({ accessTokenEnc: "k1.not.real.ciphertext" })
      .where(eq(schema.sessions.id, sessionId));
    expect(await store.getUser(sessionId)).toBeNull();
    // The dead row is revoked so it can't be retried forever.
    const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    expect(rows[0]?.revokedAt).not.toBeNull();
    expect(rows[0]?.accessTokenEnc).toBe("");
  });

  it("revokes a session with an undecryptable access token without throwing", async () => {
    const sessionId = await store.create(tokens);
    await db
      .update(schema.sessions)
      .set({ accessTokenEnc: "k1.not.real.ciphertext" })
      .where(eq(schema.sessions.id, sessionId));
    expect(await store.revoke(sessionId)).toEqual({ loginId: "login-1" });
    expect(await store.getUser(sessionId)).toBeNull();
  });

  it("refreshes an expired access token exactly once under concurrency", async () => {
    const sessionId = await store.create({ ...tokens, expiresIn: 0 });
    const [a, b] = await Promise.all([store.getUser(sessionId), store.getUser(sessionId)]);
    expect(a?.accessToken).toBe("at-2");
    expect(b?.accessToken).toBe("at-2");
    expect(refreshCalls).toEqual(["rt-1"]);
  });

  it("returns null when an expired session has no refresh token", async () => {
    const sessionId = await store.create({ ...tokens, refreshToken: undefined, expiresIn: 0 });
    expect(await store.getUser(sessionId)).toBeNull();
  });

  it("clears the stored tokens when revoking (no live credentials in dead rows)", async () => {
    const sessionId = await store.create(tokens);
    await store.revoke(sessionId);
    const row = (await db.select().from(schema.sessions))[0]!;
    expect(row.revokedAt).not.toBeNull();
    expect(row.accessTokenEnc).toBe("");
    expect(row.refreshTokenEnc).toBeNull();
  });

  it("ends the session with null (not a throw) when the refresh grant is REJECTED", async () => {
    const failingStore = createSessionStore(db, cipher, {
      refresh: () => Promise.reject(new RefreshRejectedError(400)),
    });
    const sessionId = await failingStore.create({ ...tokens, expiresIn: 0 });
    await expect(failingStore.getUser(sessionId)).resolves.toBeNull();
    // The session is now revoked, not retried forever.
    const row = (await db.select().from(schema.sessions))[0]!;
    expect(row.revokedAt).not.toBeNull();
    expect(row.refreshTokenEnc).toBeNull();
  });

  it("keeps the session alive when the refresh fails transiently", async () => {
    const failingStore = createSessionStore(db, cipher, {
      refresh: () => Promise.reject(new Error("fetch failed")),
    });
    const sessionId = await failingStore.create({ ...tokens, expiresIn: 0 });
    await expect(failingStore.getUser(sessionId)).rejects.toThrow("fetch failed");
    // Transient failure did not revoke: the healthy store refreshes on the next attempt.
    expect((await store.getUser(sessionId))?.accessToken).toBe("at-2");
  });

  it("prunes attempts older than the retention window on record", async () => {
    await db
      .insert(schema.loginAttempts)
      .values({ ip: "9.9.9.9", attemptedAt: new Date(Date.now() - 25 * 60 * 60_000) });
    await store.recordAndCheck("1.2.3.4", 5, 60_000);
    const rows = await db.select().from(schema.loginAttempts);
    expect(rows.map((r) => r.ip)).toEqual(["1.2.3.4"]);
  });

  it("records and checks atomically: the max-th attempt in the window is rejected", async () => {
    // max = 3: attempts 1..2 are allowed; the 3rd attempt is the one rejected.
    expect(await store.recordAndCheck("1.2.3.4", 3, 60_000)).toBe(false);
    expect(await store.recordAndCheck("1.2.3.4", 3, 60_000)).toBe(false);
    expect(await store.recordAndCheck("1.2.3.4", 3, 60_000)).toBe(true);
    // A different IP has its own bucket.
    expect(await store.recordAndCheck("5.6.7.8", 3, 60_000)).toBe(false);
  });
});
