import { RefreshRejectedError, type RefreshedTokens } from "@medibun/medplum-backend";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { loginAttempts, sessions } from "../db/schema.js";
import type { TokenCipher } from "./crypto.js";

/**
 * Server-side session store (docs/AUTH.md). The opaque session id is the only thing
 * clients ever hold; Medplum tokens stay here, encrypted at the application level.
 * Refreshes are serialized per session with SELECT … FOR UPDATE — Medplum rotates the
 * refresh secret on every grant with no reuse window, so a race bricks the session.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<PgQueryResultHKT, any, any>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Treat tokens expiring within this skew as already expired. */
const EXPIRY_SKEW_MS = 30_000;

/** login_attempts rows older than this are pruned opportunistically. */
const ATTEMPT_RETENTION_MS = 24 * 60 * 60_000;

/** Revocation values: tokens are cleared so dead rows hold no live credentials. */
const CLEARED_TOKENS = { accessTokenEnc: "", refreshTokenEnc: null } as const;

export type NewSession = {
  readonly profileReference: string;
  readonly loginId: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn: number;
};

export type SessionUser = {
  readonly profileReference: string;
  readonly accessToken: string;
};

export type SessionStore = {
  readonly create: (s: NewSession) => Promise<string>;
  readonly getUser: (sessionId: string) => Promise<SessionUser | null>;
  readonly revoke: (sessionId: string) => Promise<{ loginId: string } | null>;
  /**
   * Atomically record this attempt and return whether the IP is now over the limit
   * within the window. One statement to insert + count closes the check-then-act race
   * that let parallel requests all pass a separate pre-check.
   */
  readonly recordAndCheck: (ip: string, max: number, windowMs: number) => Promise<boolean>;
};

export function createSessionStore(
  db: Db,
  cipher: TokenCipher,
  deps: { refresh: (refreshToken: string) => Promise<RefreshedTokens> },
): SessionStore {
  function expiresAt(expiresIn: number): Date {
    return new Date(Date.now() + expiresIn * 1000);
  }

  function isFresh(accessExpiresAt: Date): boolean {
    return accessExpiresAt.getTime() > Date.now() + EXPIRY_SKEW_MS;
  }

  /** Decrypt failures (rotated key, corruption) mean the session is unusable — never a 500. */
  function tryDecrypt(enc: string): string | null {
    try {
      return cipher.decrypt(enc);
    } catch {
      return null;
    }
  }

  /** Identifier-only signal: a key rotation/misconfig self-revokes every session — make
   *  that distinguishable from ordinary 401s in the logs (security review, 2026-07-01). */
  function logUndecryptable(sessionId: string): void {
    console.log(JSON.stringify({ msg: "session revoked: stored token undecryptable", sessionId }));
  }

  return {
    async create(s) {
      const id = crypto.randomUUID();
      await db.insert(sessions).values({
        id,
        profileReference: s.profileReference,
        medplumLoginId: s.loginId,
        accessTokenEnc: cipher.encrypt(s.accessToken),
        refreshTokenEnc: s.refreshToken !== undefined ? cipher.encrypt(s.refreshToken) : null,
        accessExpiresAt: expiresAt(s.expiresIn),
      });
      return id;
    },

    async getUser(sessionId) {
      if (!UUID_RE.test(sessionId)) {
        return null;
      }
      const rows = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
      const session = rows[0];
      if (!session) {
        return null;
      }
      if (isFresh(session.accessExpiresAt)) {
        const accessToken = tryDecrypt(session.accessTokenEnc);
        if (accessToken === null) {
          logUndecryptable(sessionId);
          await db
            .update(sessions)
            .set({ revokedAt: new Date(), ...CLEARED_TOKENS })
            .where(eq(sessions.id, sessionId));
          return null;
        }
        return { profileReference: session.profileReference, accessToken };
      }
      if (session.refreshTokenEnc === null) {
        return null;
      }
      // READ COMMITTED is REQUIRED and pinned, not inherited: the re-read after the lock
      // must see the OTHER transaction's committed refresh. Under REPEATABLE READ the
      // locked read returns this tx's stale snapshot (the freshness re-check fails to
      // fire) → a double refresh against an already-rotated token bricks the session.
      return db.transaction(
        async (tx) => {
          const locked = (
            await tx
              .select()
              .from(sessions)
              .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
              .for("update")
          )[0];
          if (!locked) {
            return null;
          }
          if (isFresh(locked.accessExpiresAt)) {
            // Another worker refreshed while we waited on the lock.
            const accessToken = tryDecrypt(locked.accessTokenEnc);
            if (accessToken === null) {
              logUndecryptable(sessionId);
              await tx
                .update(sessions)
                .set({ revokedAt: new Date(), ...CLEARED_TOKENS })
                .where(eq(sessions.id, sessionId));
              return null;
            }
            return { profileReference: locked.profileReference, accessToken };
          }
          if (locked.refreshTokenEnc === null) {
            return null;
          }
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
          await tx
            .update(sessions)
            .set({
              accessTokenEnc: cipher.encrypt(refreshed.accessToken),
              refreshTokenEnc:
                refreshed.refreshToken !== undefined
                  ? cipher.encrypt(refreshed.refreshToken)
                  : null,
              accessExpiresAt: expiresAt(refreshed.expiresIn),
            })
            .where(eq(sessions.id, sessionId));
          return {
            profileReference: locked.profileReference,
            accessToken: refreshed.accessToken,
          };
        },
        { isolationLevel: "read committed" },
      );
    },

    async revoke(sessionId) {
      if (!UUID_RE.test(sessionId)) {
        return null;
      }
      return db.transaction(async (tx) => {
        const locked = (
          await tx
            .select()
            .from(sessions)
            .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
            .for("update")
        )[0];
        if (!locked) {
          return null;
        }
        await tx
          .update(sessions)
          .set({ revokedAt: new Date(), ...CLEARED_TOKENS })
          .where(eq(sessions.id, sessionId));
        return { loginId: locked.medplumLoginId };
      });
    },

    async recordAndCheck(ip, max, windowMs) {
      const since = new Date(Date.now() - windowMs);
      // Record-then-count in one transaction: every request inserts its own attempt
      // before counting, so the count is monotonic and the limit can't be bypassed by
      // a separate pre-check. Under READ COMMITTED a simultaneous burst can each
      // under-count by its concurrency (uncommitted inserts aren't visible), so the
      // bound is "≤ max + burst", not exact — fine for a defense-in-depth login throttle
      // sitting in front of Medplum's own per-IP limiter.
      return db.transaction(async (tx) => {
        await tx.insert(loginAttempts).values({ ip });
        const rows = await tx
          .select({ n: sql<number>`count(*)` })
          .from(loginAttempts)
          .where(and(eq(loginAttempts.ip, ip), gt(loginAttempts.attemptedAt, since)));
        await tx
          .delete(loginAttempts)
          .where(lt(loginAttempts.attemptedAt, new Date(Date.now() - ATTEMPT_RETENTION_MS)));
        // This attempt counts: the Nth attempt within the window is the one rejected.
        return Number(rows[0]?.n ?? 0) >= max;
      });
    },
  };
}
