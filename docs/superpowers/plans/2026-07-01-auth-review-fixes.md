# Auth Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the surviving findings from the 2026-07-01 code review of `feat/auth-sessions` so the
auth foundation is hardened before merge: no 500s from undecryptable session rows, migrations wired
into dev/CI, transient-vs-rejected refresh failures distinguished, bounded lock/pool waits,
graceful shutdown, and tests that exercise the real schema.

**Architecture:** All changes stay inside the existing boundaries — session/token handling in
`apps/api/src/auth/`, Medplum HTTP specifics in `packages/medplum-backend`, wiring in
`apps/api/src/index.ts`. No new dependencies, no schema changes, no AccessPolicy changes. Work
happens as new commits on the already-checked-out `feat/auth-sessions` branch.

**Tech Stack:** TypeScript 6 strict, Hono, drizzle-orm + pg + PGlite, Vitest, GitHub Actions.

**Approval context:** Alec explicitly approved implementing these review findings (2026-07-01).
This touches auth code, so the `security-reviewer` subagent MUST run at the end (Task 7) per
CLAUDE.md definition of done.

**Review-finding triage encoded in this plan:**

| Finding                                                           | Disposition                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Unguarded `cipher.decrypt()` → 500s                            | Fix (Task 1)                                                                                                                                                                                                             |
| 2. Migrations never run automatically                             | Fix (Task 3)                                                                                                                                                                                                             |
| 3. Medplum memberships contract                                   | **Resolved by source verification — no behavior change.** Medplum v5.1.9 `sendLoginResult` returns `code` XOR `memberships` (mutually exclusive branches). Document the verified contract in a comment (Task 2, Step 7). |
| 4. Row lock held across unbounded network call / no pool timeouts | Fix (Task 2)                                                                                                                                                                                                             |
| 5. No graceful shutdown                                           | Fix (Task 6)                                                                                                                                                                                                             |
| 6. Test DDL drifts from real migration                            | Fix (Task 4)                                                                                                                                                                                                             |
| 7. Per-route domain-error mapping                                 | **Deferred** — two routes today; centralize when the MFA/staff-login PR adds a third (YAGNI, CLAUDE.md simplicity-first).                                                                                                |
| 8. Auth config constants scattered                                | **Deferred** — four constants, one consumer each; env-tunable config is speculative flexibility until a deployment needs it.                                                                                             |
| 9. `drizzle.config.ts` empty-string URL fallback                  | Fix (Task 5)                                                                                                                                                                                                             |

---

### Task 1: Guard token decryption — undecryptable session rows are invalid sessions, not 500s

An undecryptable `accessTokenEnc` (key rotation, corruption) currently throws out of
`getUser` (fast path line 96, locked path line 122) and `revoke` (line 175), surfacing as 500s —
including a crashing logout. Fix: decrypt failures in `getUser` revoke the dead row and return
`null` (client re-authenticates); `revoke` stops decrypting entirely because its only caller
(`index.ts` logout) uses just `loginId`.

**Files:**

- Modify: `apps/api/src/auth/sessions.ts`
- Modify: `apps/api/src/index.ts` (no change needed to logout — verify only)
- Test: `apps/api/src/auth/sessions.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside `describe("session store", ...)` in `apps/api/src/auth/sessions.test.ts`:

```ts
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
```

Add `import { eq } from "drizzle-orm";` to the test file's imports.

Update the existing revocation test (`"returns null after revocation and surfaces the tokens to
revoke upstream"`) for the narrowed contract:

```ts
it("returns null after revocation and surfaces the login id to revoke upstream", async () => {
  const sessionId = await store.create(tokens);
  const revoked = await store.revoke(sessionId);
  expect(revoked).toEqual({ loginId: "login-1" });
  expect(await store.getUser(sessionId)).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm --filter @medibun/api test -- sessions.test`
Expected: the two new tests FAIL (thrown `malformed encrypted token` / mismatched revoke shape);
existing tests pass.

- [ ] **Step 3: Implement in `sessions.ts`**

Change the `revoke` signature in the `SessionStore` type (line 45):

```ts
  readonly revoke: (sessionId: string) => Promise<{ loginId: string } | null>;
```

Inside `createSessionStore`, add next to `isFresh`:

```ts
/** Decrypt failures (rotated key, corruption) mean the session is unusable — never a 500. */
function tryDecrypt(enc: string): string | null {
  try {
    return cipher.decrypt(enc);
  } catch {
    return null;
  }
}
```

Replace the `getUser` fast path (lines 93–98):

```ts
if (isFresh(session.accessExpiresAt)) {
  const accessToken = tryDecrypt(session.accessTokenEnc);
  if (accessToken === null) {
    await db
      .update(sessions)
      .set({ revokedAt: new Date(), ...CLEARED_TOKENS })
      .where(eq(sessions.id, sessionId));
    return null;
  }
  return { profileReference: session.profileReference, accessToken };
}
```

Replace the locked-path fresh branch (lines 118–124) the same way, using `tx` instead of `db`:

```ts
if (isFresh(locked.accessExpiresAt)) {
  // Another worker refreshed while we waited on the lock.
  const accessToken = tryDecrypt(locked.accessTokenEnc);
  if (accessToken === null) {
    await tx
      .update(sessions)
      .set({ revokedAt: new Date(), ...CLEARED_TOKENS })
      .where(eq(sessions.id, sessionId));
    return null;
  }
  return { profileReference: locked.profileReference, accessToken };
}
```

(The refresh-token decrypt at line 130 is already inside the try/catch that revokes cleanly — no
change.)

In `revoke`, delete line 175 (`const accessToken = cipher.decrypt(...)`) and return only the
login id:

```ts
await tx
  .update(sessions)
  .set({ revokedAt: new Date(), ...CLEARED_TOKENS })
  .where(eq(sessions.id, sessionId));
return { loginId: locked.medplumLoginId };
```

- [ ] **Step 4: Verify the only `revoke` caller ignores `accessToken`**

Run: `grep -rn "\.revoke(\|revoked\." apps/api/src --include="*.ts" | grep -v test`
Expected: `index.ts` logout uses `revoked.loginId` only. If anything else destructures
`accessToken` from a revoke result, STOP and re-examine before proceeding.

- [ ] **Step 5: Run the suite and typecheck**

Run: `pnpm --filter @medibun/api test && pnpm --filter @medibun/api typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/sessions.ts apps/api/src/auth/sessions.test.ts
git commit -m "fix(api): treat undecryptable session tokens as invalid sessions, not 500s"
```

---

### Task 2: Distinguish rejected vs transient refresh failures; bound the in-lock network call and pool waits

Today ANY error from the Medplum refresh (including a network blip) revokes the session inside the
locked transaction — and the refresh fetch has no timeout while it holds a `FOR UPDATE` row lock,
so a stalled Medplum call can pile up lock-waiters until the pg pool is exhausted. Fix: a typed
`RefreshRejectedError` (Medplum said no: 400/401) is the ONLY thing that revokes; transient errors
rethrow (route 500s once, session survives, retry works). Bound the token-grant fetch with
`AbortSignal.timeout`, and give the pool explicit limits so waiters fail fast instead of hanging.

**Timeout ordering invariant (why these numbers):** the refresh fetch aborts at 15s; lock-waiters'
`statement_timeout` is 30s (> 15s, so waiters outlast a slow-but-succeeding holder);
`idle_in_transaction_session_timeout` is 60s as a backstop that can never fire on the success path.
A backstop that killed the transaction AFTER Medplum rotated the refresh token would brick the
session — the ordering prevents that.

**Files:**

- Modify: `packages/medplum-backend/src/user-login.ts`
- Modify: `packages/medplum-backend/src/index.ts` (export the new error)
- Modify: `apps/api/src/auth/sessions.ts`
- Modify: `apps/api/src/index.ts`
- Test: `packages/medplum-backend/src/user-login.test.ts`, `apps/api/src/auth/sessions.test.ts`

- [ ] **Step 1: Write the failing test for the typed rejection in medplum-backend**

Append to `packages/medplum-backend/src/user-login.test.ts` (match the file's existing mock-fetch
style — it stubs `fetchImpl`; reuse its existing config fixture):

```ts
it("throws RefreshRejectedError when the refresh grant is rejected (400/401)", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
  await expect(refreshUserTokens(config, "dead-refresh-token", fetchImpl)).rejects.toBeInstanceOf(
    RefreshRejectedError,
  );
});

it("throws a plain Error (not RefreshRejectedError) when the refresh transport fails", async () => {
  const fetchImpl = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;
  const err = await refreshUserTokens(config, "rt", fetchImpl).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(RefreshRejectedError);
});
```

Add `RefreshRejectedError` to the test file's imports from `./user-login.js`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @medibun/medplum-backend test -- user-login`
Expected: FAIL — `RefreshRejectedError` is not exported.

- [ ] **Step 3: Implement in `user-login.ts`**

Add after `MultipleMembershipsError` (line 59):

```ts
/**
 * The refresh_token grant was definitively rejected by Medplum (400/401 — expired,
 * rotated-and-reused, or revoked). This is the ONLY refresh failure that should end a
 * session; transport/5xx errors are transient and must leave the session intact.
 */
export class RefreshRejectedError extends Error {
  constructor(status: number) {
    super(`medplum refresh grant rejected (status ${status})`);
    this.name = "RefreshRejectedError";
  }
}
```

In `tokenGrant`, bound the fetch and map the rejection. Replace the fetch call and error check
(lines 78–85):

```ts
const res = await fetchImpl(`${config.baseUrl}oauth2/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: params.toString(),
  // Bounded on purpose: the session store calls this while holding a row lock.
  signal: AbortSignal.timeout(15_000),
});
if (!res.ok) {
  if (params.get("grant_type") === "refresh_token" && (res.status === 400 || res.status === 401)) {
    throw new RefreshRejectedError(res.status);
  }
  throw new Error(`medplum token exchange failed (status ${res.status})`);
}
```

Export it from `packages/medplum-backend/src/index.ts` alongside the other user-login exports
(add `RefreshRejectedError` to the existing export list from `./user-login.js`).

- [ ] **Step 4: Run medplum-backend tests**

Run: `pnpm --filter @medibun/medplum-backend test`
Expected: PASS. If existing mock-fetch tests break because the mock ignores `signal`, they won't —
an unused extra init field is inert; if a mock asserts on exact init, update that assertion.

- [ ] **Step 5: Write the failing session-store tests for revoke-only-on-rejection**

In `apps/api/src/auth/sessions.test.ts`, find the existing test covering refresh failure (it
asserts the session ends when `deps.refresh` rejects). Replace/extend so both behaviors are pinned:

```ts
it("ends the session when the refresh grant is REJECTED", async () => {
  const sessionId = await store.create({ ...tokens, expiresIn: 0 });
  failRefreshWith = new RefreshRejectedError(400);
  expect(await store.getUser(sessionId)).toBeNull();
  // Session is revoked — a later successful refresh cannot resurrect it.
  failRefreshWith = undefined;
  expect(await store.getUser(sessionId)).toBeNull();
});

it("keeps the session alive when the refresh fails TRANSIENTLY", async () => {
  const sessionId = await store.create({ ...tokens, expiresIn: 0 });
  failRefreshWith = new Error("fetch failed");
  await expect(store.getUser(sessionId)).rejects.toThrow("fetch failed");
  // Transient failure did not revoke: the next attempt succeeds.
  failRefreshWith = undefined;
  expect((await store.getUser(sessionId))?.accessToken).toBe("at-2");
});
```

Wire `failRefreshWith` into the existing `beforeEach` refresh stub:

```ts
let failRefreshWith: Error | undefined;

// in beforeEach, replace the refresh stub:
failRefreshWith = undefined;
store = createSessionStore(db, cipher, {
  refresh: (refreshToken) => {
    if (failRefreshWith) {
      return Promise.reject(failRefreshWith);
    }
    refreshCalls.push(refreshToken);
    return Promise.resolve({ accessToken: "at-2", refreshToken: "rt-2", expiresIn: 3600 });
  },
});
```

Import `RefreshRejectedError` from `@medibun/medplum-backend` in the test file.

- [ ] **Step 6: Run to verify the transient test fails, then implement in `sessions.ts`**

Run: `pnpm --filter @medibun/api test -- sessions.test`
Expected: the TRANSIENT test FAILS (current code revokes on any error).

Then change the catch in `getUser`'s refresh block (line 131):

```ts
let refreshed: RefreshedTokens;
try {
  refreshed = await deps.refresh(cipher.decrypt(locked.refreshTokenEnc));
} catch (err) {
  if (!(err instanceof RefreshRejectedError)) {
    // Transient (network/5xx/timeout): keep the session; this request 500s
    // and the next retry refreshes. Only a definitive rejection ends it.
    throw err;
  }
  // Refresh token expired or Login revoked upstream: end the session cleanly
  // (callers see 401, not 500) instead of retrying a dead grant forever.
  await tx
    .update(sessions)
    .set({ revokedAt: new Date(), ...CLEARED_TOKENS })
    .where(eq(sessions.id, sessionId));
  return null;
}
```

Add `RefreshRejectedError` to the imports from `@medibun/medplum-backend` at the top of
`sessions.ts` (change the type-only import to also import the class:
`import { RefreshRejectedError, type RefreshedTokens } from "@medibun/medplum-backend";`).

- [ ] **Step 7: Pool limits in `index.ts` + document the verified memberships contract**

In `apps/api/src/index.ts`, replace line 40:

```ts
// Bounded waits (docs in plan 2026-07-01): fetch timeout 15s < statement_timeout 30s
// < idle_in_transaction 60s, so a slow-but-succeeding refresh is never killed mid-grant.
const pool = new pg.Pool({
  connectionString: dbUrl,
  max: 10,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
  idle_in_transaction_session_timeout: 60_000,
});
```

In `packages/medplum-backend/src/user-login.ts`, extend the comment above the memberships guard
(line 153) — replace the existing single-line context with:

```ts
// Verified against the Medplum v5.1.9 server source (sendLoginResult): `code` and
// `memberships` are mutually exclusive response branches, so a resolved single-
// membership login can never carry `memberships` — this guard cannot false-positive.
if (body.memberships !== undefined || body.code === undefined || body.login === undefined) {
  throw new MultipleMembershipsError();
}
```

- [ ] **Step 8: Full test + typecheck across both packages**

Run: `pnpm --filter @medibun/medplum-backend test && pnpm --filter @medibun/api test && pnpm typecheck`
Expected: PASS. (`statement_timeout` / `idle_in_transaction_session_timeout` are valid pg
`ClientConfig` fields; if `@types/pg` in this repo predates them, extend via
`new pg.Pool({ ... } as pg.PoolConfig)` — check the actual type error before casting.)

- [ ] **Step 9: Commit**

```bash
git add packages/medplum-backend/src apps/api/src
git commit -m "fix(auth): revoke sessions only on definitive refresh rejection; bound refresh fetch and pool waits"
```

---

### Task 3: Wire migrations into dev setup, CI, and a startup fail-fast

`db:migrate` exists but nothing runs it: a fresh environment boots cleanly and 500s on first login
with `relation "sessions" does not exist`. Fix at all three layers: `setup-dev.sh` migrates local
dev; CI gets the Postgres service (also un-skips the concurrency test — a recorded deferred item);
startup fails fast with an actionable message when the schema is missing.

**Files:**

- Modify: `infra/medplum/setup-dev.sh:138` (append after the `.env` write)
- Modify: `apps/api/package.json:10` (`db:migrate` env-file flag)
- Modify: `.github/workflows/ci.yml`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/auth/sessions.concurrency.test.ts:57` (remove the CI gate)

- [ ] **Step 1: Make `db:migrate` runnable without a local `.env` (CI)**

In `apps/api/package.json`, change the script (line 10) from `--env-file=` to tolerate a missing
file so CI can supply `EXPERIENCE_DATABASE_URL` via the environment:

```json
    "db:migrate": "tsx --env-file-if-exists=../../infra/medplum/.env src/db/migrate.ts",
```

- [ ] **Step 2: Migrate in `setup-dev.sh`**

Append after line 138 (`echo "✓ wrote $HERE/.env ..."`):

```bash
echo "→ migrating experience db…"
(cd "$HERE/../.." && pnpm --filter @medibun/api db:migrate) \
  && echo "  ✓ experience db migrated" \
  || { echo "✗ experience db migration failed"; exit 1; }
```

(`$HERE` is the script's own directory — confirm the variable name at the top of the script; if
the script uses a different name for its dir, use that.)

- [ ] **Step 3: CI Postgres service + migrate step + un-gate the concurrency test**

In `.github/workflows/ci.yml`, add to the `ci` job (same indentation level as `steps:`):

```yaml
services:
  experience-postgres:
    image: postgres:17-alpine
    env:
      POSTGRES_USER: medibun
      POSTGRES_PASSWORD: medibun
      POSTGRES_DB: medibun_experience
    ports:
      - 5433:5432
    options: >-
      --health-cmd "pg_isready -U medibun -d medibun_experience"
      --health-interval 5s
      --health-timeout 5s
      --health-retries 10
```

Add to the workflow-level `env:` block:

```yaml
EXPERIENCE_DATABASE_URL: postgres://medibun:medibun@localhost:5433/medibun_experience
```

Add a step between "Install dependencies" and "Prettier":

```yaml
- name: Migrate experience db (test schema)
  run: pnpm --filter @medibun/api db:migrate
```

In `apps/api/src/auth/sessions.concurrency.test.ts` line 57, remove the CI gate — CI now has a
real Postgres, which is the whole point of this suite:

```ts
// The per-test ctx.skip() below guards a missing DB (local runs without the dev stack);
// CI provides a real Postgres service and runs this suite for the FOR UPDATE guarantee.
describe("session refresh under real DB concurrency", () => {
```

- [ ] **Step 4: Startup fail-fast in `index.ts`**

In `buildAuthDeps()` after `const db = drizzle(pool);` (line 41), add:

```ts
// Fail fast on an unmigrated DB: a clear boot error beats a 500 on first login.
void pool.query("select 1 from sessions limit 1").catch((err: unknown) => {
  console.error(
    JSON.stringify({
      msg: "experience db check failed — run: pnpm --filter @medibun/api db:migrate",
    }),
  );
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: Verify locally**

Run (dev stack up — `docker compose -f infra/medplum/docker-compose.yml up -d experience-postgres`):

```bash
pnpm --filter @medibun/api db:migrate          # applies cleanly / no-ops
pnpm --filter @medibun/api test                 # concurrency suite now RUNS (not skipped) locally
```

Expected: migrate succeeds; the concurrency test executes against localhost:5433 and passes.
Also verify the fail-fast: point `EXPERIENCE_DATABASE_URL` at a fresh empty database (e.g.
`postgres://medibun:medibun@localhost:5433/postgres`), start `pnpm --filter @medibun/api dev`
with auth env set, and confirm the process exits with the migrate hint.

- [ ] **Step 6: Commit**

```bash
git add infra/medplum/setup-dev.sh apps/api/package.json .github/workflows/ci.yml \
  apps/api/src/index.ts apps/api/src/auth/sessions.concurrency.test.ts
git commit -m "fix(api): wire db migrations into dev setup, CI (postgres service), and a startup fail-fast"
```

CI on the pushed branch is the real verify step for the service/gate changes — check the run.

---

### Task 4: Tests apply the real migration instead of hand-written DDL

`sessions.test.ts` hand-writes `CREATE TABLE` DDL that already drifts from the checked-in
migration (it omits `login_attempts_ip_time_idx`). Apply the real migration with drizzle's PGlite
migrator so tests and prod share one schema definition.

**Files:**

- Modify: `apps/api/src/auth/sessions.test.ts:25-46`

- [ ] **Step 1: Replace the DDL with the migrator**

Replace the two `client.query(CREATE TABLE ...)` blocks in `beforeEach` (lines 28–46) with:

```ts
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/pglite/migrator";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

// in beforeEach:
const client = new PGlite();
db = drizzle(client, { schema });
await migrate(db, { migrationsFolder });
```

(Keep the existing imports; `drizzle-orm/pglite/migrator` ships with the already-installed
`drizzle-orm`.)

- [ ] **Step 2: Run the suite**

Run: `pnpm --filter @medibun/api test -- sessions.test`
Expected: PASS — same tests, real schema (now including the index). If the PGlite migrator
chokes on anything in `0000_massive_sunfire.sql`, STOP and report rather than reintroducing DDL.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/auth/sessions.test.ts
git commit -m "test(api): apply the real drizzle migration in session tests instead of duplicated DDL"
```

---

### Task 5: Fail fast in drizzle.config.ts when EXPERIENCE_DATABASE_URL is unset

The `?? ""` fallback lets DB-connected drizzle-kit commands run with a blank URL and fail
confusingly. `generate` needs no DB — so only provide credentials when they exist.

**Files:**

- Modify: `apps/api/drizzle.config.ts`

- [ ] **Step 1: Implement**

Replace the file body:

```ts
import { defineConfig } from "drizzle-kit";

// `generate` reads only schema.ts and needs no DB. DB-connected commands (push/studio)
// get drizzle-kit's own "dbCredentials required" error instead of a blank-URL hang.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  ...(process.env.EXPERIENCE_DATABASE_URL
    ? { dbCredentials: { url: process.env.EXPERIENCE_DATABASE_URL } }
    : {}),
});
```

If `defineConfig`'s type requires `dbCredentials` unconditionally for the postgresql dialect, use
this fallback instead (clear error at connect time, still works for `generate`):

```ts
  dbCredentials: {
    url:
      process.env.EXPERIENCE_DATABASE_URL ??
      "postgresql://EXPERIENCE_DATABASE_URL-is-not-set:5432/unset",
  },
```

- [ ] **Step 2: Verify both paths**

```bash
unset EXPERIENCE_DATABASE_URL; pnpm --filter @medibun/api db:generate   # still works (no schema changes → no new migration)
pnpm --filter @medibun/api typecheck
```

Expected: `db:generate` reports no changes; typecheck passes. Delete any accidentally generated
migration if the schema was unchanged but drizzle-kit emitted one anyway.

- [ ] **Step 3: Commit**

```bash
git add apps/api/drizzle.config.ts
git commit -m "chore(api): fail clearly when EXPERIENCE_DATABASE_URL is unset in drizzle config"
```

---

### Task 6: Graceful shutdown — drain the server, close the pool

**Files:**

- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Implement**

`buildAuthDeps()` must expose its pool. Change its signature and return:

```ts
function buildAuthDeps(): { auth: AuthDeps; pool: pg.Pool } | undefined {
  // ... unchanged body ...
  return {
    pool,
    auth: {
      // ... the existing AuthDeps object, unchanged ...
    },
  };
}
```

Update the wiring at the bottom of the file:

```ts
const authWiring = buildAuthDeps();

const app = createApp({
  log: (entry) => console.log(JSON.stringify(entry)),
  checkMedplum: checkMedplumConnection,
  auth: authWiring?.auth,
  getPatientProfile,
});

// ... devUnauthenticatedRoutes log unchanged ...

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(JSON.stringify({ msg: "api listening", port: info.port }));
});

// Drain in-flight requests, then release DB connections. The unref'd failsafe means a
// wedged connection can't block shutdown forever (exit 1 → the platform force-restarts).
const shutdown = (signal: string): void => {
  console.log(JSON.stringify({ msg: "shutting down", signal }));
  server.close(() => {
    void (authWiring?.pool.end() ?? Promise.resolve()).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
```

- [ ] **Step 2: Verify by hand (index.ts is wiring — no unit test)**

With the dev stack up and auth env set:

```bash
pnpm --filter @medibun/api dev &
sleep 3 && curl -s localhost:3001/health   # confirm serving (use config.port if different)
kill -TERM %1                              # expect {"msg":"shutting down","signal":"SIGTERM"} and clean exit
```

Expected: shutdown log line, process exits 0 promptly.

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm --filter @medibun/api typecheck
git add apps/api/src/index.ts
git commit -m "fix(api): graceful shutdown — drain server and close the pg pool on SIGTERM/SIGINT"
```

---

### Task 7: Definition of done — full gate + security review

- [ ] **Step 1: Full workspace gate**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm format:check`
Expected: all PASS. Fix anything surfaced before proceeding.

- [ ] **Step 2: Run the `security-reviewer` subagent (MANDATORY — auth-touching change)**

Dispatch the `security-reviewer` agent on the branch diff (`git diff b857eb1...HEAD` — just these
fix commits). Address any violation it reports before calling the work done.

- [ ] **Step 3: Update docs/AUTH.md review log**

Append one line to the review/decision log section of `docs/AUTH.md` (match its existing format):
refresh failures now revoke only on definitive rejection (`RefreshRejectedError`); undecryptable
tokens invalidate the session; migrations wired into setup-dev/CI; graceful shutdown added.

```bash
git add docs/AUTH.md
git commit -m "docs(auth): record 2026-07-01 review-fix decisions in AUTH.md"
```

- [ ] **Step 4: Report**

Summarize: commits added, tests added (count), CI expectations (concurrency suite now runs), and
the two explicitly deferred findings (error-mapper centralization; config consolidation) so they
land in the next auth PR's scope instead of silently disappearing.
