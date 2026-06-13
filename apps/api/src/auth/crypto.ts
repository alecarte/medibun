import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Application-level encryption for Medplum tokens at rest (docs/AUTH.md):
 * AES-256-GCM, key from the environment/secret manager — never the database.
 * Format: keyId.base64url(iv).base64url(ciphertext).base64url(authTag) — the key id
 * makes key rotation identifiable per row instead of a re-encrypt-everything event.
 */

const KEY_ID = "k1";

export type TokenCipher = {
  readonly encrypt: (plaintext: string) => string;
  readonly decrypt: (encrypted: string) => string;
};

export function createTokenCipher(base64Key: string): TokenCipher {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) {
    throw new Error("SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }

  return {
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${KEY_ID}.${iv.toString("base64url")}.${ct.toString("base64url")}.${tag.toString("base64url")}`;
    },
    decrypt(encrypted) {
      const [kid, iv, ct, tag] = encrypted.split(".");
      if (!kid || !iv || !ct || !tag) {
        throw new Error("malformed encrypted token");
      }
      if (kid !== KEY_ID) {
        throw new Error(`unknown encryption key id: ${kid}`);
      }
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ct, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
