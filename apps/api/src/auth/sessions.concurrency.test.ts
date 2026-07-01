import { randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTokenCipher } from "./crypto.js";
import { createSessionStore } from "./sessions.js";

/**
 * REAL concurrency tests against Postgres — PGlite (single connection) cannot exercise
 * SELECT ... FOR UPDATE lock contention, so the headline "refresh exactly once under
 * concurrency" guarantee is only meaningful here. Skips when no DB is reachable (CI has
 * no Postgres service); run locally with the dev experience-postgres up:
 *   EXPERIENCE_DATABASE_URL=postgres://medibun:medibun@localhost:5433/medibun_experience
 */
const url =
  process.env.EXPERIENCE_DATABASE_URL ??
  "postgres://medibun:medibun@localhost:5433/medibun_experience";

const cipher = createTokenCipher(randomBytes(32).toString("base64"));
const tokens = {
  profileReference: "Patient/p-conc",
  loginId: "login-conc",
  accessToken: "at-1",
  refreshToken: "rt-1",
  expiresIn: 0, // already stale → forces the locked refresh path
};

let pool: pg.Pool;
let reachable = false;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 1500 });
  try {
    await pool.query("select 1");
    reachable = true;
  } catch {
    reachable = false;
  }
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  if (reachable) {
    await pool.query("delete from sessions where profile_reference = $1", [
      tokens.profileReference,
    ]);
  }
});

// The per-test ctx.skip() below guards a missing DB (local runs without the dev stack);
// CI provides a real experience-postgres service and runs this suite for the FOR UPDATE
// guarantee — the headline "refresh exactly once" behavior is only proven here.
describe("session refresh under real DB concurrency", () => {
  it("refreshes an expired token exactly once across two concurrent connections", async (ctx) => {
    if (!reachable) {
      ctx.skip();
      return;
    }
    // Two stores on the SAME pool but issuing concurrent transactions. The refresh fn
    // blocks on a barrier so both getUser calls are provably mid-transaction together.
    let refreshCount = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const refresh = async () => {
      refreshCount += 1;
      await gate; // hold the first refresher inside its locked tx
      return { accessToken: "at-2", refreshToken: "rt-2", expiresIn: 3600 };
    };
    const store = createSessionStore(drizzle(pool), cipher, { refresh });

    const sessionId = await store.create(tokens);

    const a = store.getUser(sessionId);
    const b = store.getUser(sessionId);
    // Give both a moment to contend for the row lock, then let the holder finish.
    await new Promise((r) => setTimeout(r, 150));
    release();
    const [ua, ub] = await Promise.all([a, b]);

    // Exactly one refresh ran; the loser saw the committed new token via the post-lock re-check.
    expect(refreshCount).toBe(1);
    expect(ua?.accessToken).toBe("at-2");
    expect(ub?.accessToken).toBe("at-2");
  });
});
