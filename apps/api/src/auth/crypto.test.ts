import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createTokenCipher } from "./crypto.js";

const key = randomBytes(32).toString("base64");

describe("createTokenCipher", () => {
  it("round-trips a token", () => {
    const cipher = createTokenCipher(key);
    const enc = cipher.encrypt("medplum-access-token");
    expect(enc).not.toContain("medplum-access-token");
    expect(cipher.decrypt(enc)).toBe("medplum-access-token");
  });

  it("produces a different ciphertext every call (random IV)", () => {
    const cipher = createTokenCipher(key);
    expect(cipher.encrypt("same")).not.toBe(cipher.encrypt("same"));
  });

  it("rejects tampered ciphertext", () => {
    const cipher = createTokenCipher(key);
    const enc = cipher.encrypt("token");
    const [kid, iv, ct, tag] = enc.split(".");
    const flipped = (ct![0] === "A" ? "B" : "A") + ct!.slice(1);
    expect(() => cipher.decrypt(`${kid}.${iv}.${flipped}.${tag}`)).toThrow();
  });

  it("prefixes a key id so rotation can identify the encrypting key", () => {
    const cipher = createTokenCipher(key);
    expect(cipher.encrypt("token").startsWith("k1.")).toBe(true);
    expect(() => cipher.decrypt(cipher.encrypt("token").replace(/^k1\./, "k9."))).toThrow(/key/);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => createTokenCipher(randomBytes(16).toString("base64"))).toThrow(/32/);
  });
});
