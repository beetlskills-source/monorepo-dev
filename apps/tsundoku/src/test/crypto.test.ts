import { describe, expect, it } from "vitest";
import {
  DecryptionError,
  EncryptionKeyError,
  decryptSecret,
  encryptSecret,
  fromBase64Url,
  requireEncryptionKey,
  toBase64Url,
} from "../lib/crypto";

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(
      Array.from(bytes),
    );
  });

  it("produces an unpadded, URL-safe alphabet", () => {
    const encoded = toBase64Url(new Uint8Array([251, 239, 190]));
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });
});

describe("requireEncryptionKey", () => {
  it("rejects missing or blank keys", () => {
    expect(() => requireEncryptionKey(undefined)).toThrow(EncryptionKeyError);
    expect(() => requireEncryptionKey("   ")).toThrow(EncryptionKeyError);
  });

  it("returns a present key unchanged", () => {
    expect(requireEncryptionKey("key-123")).toBe("key-123");
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a refresh token without leaking the plaintext", async () => {
    const payload = await encryptSecret("1//refresh-token", "key-123");
    expect(payload.startsWith("v1.")).toBe(true);
    expect(payload).not.toContain("refresh-token");
    await expect(decryptSecret(payload, "key-123")).resolves.toBe(
      "1//refresh-token",
    );
  });

  it("uses a fresh IV so identical inputs differ", async () => {
    const first = await encryptSecret("same", "key");
    const second = await encryptSecret("same", "key");
    expect(first).not.toBe(second);
  });

  it("fails to decrypt with the wrong key", async () => {
    const payload = await encryptSecret("secret", "key-a");
    await expect(decryptSecret(payload, "key-b")).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it("rejects malformed payloads", async () => {
    await expect(decryptSecret("not-a-payload", "key")).rejects.toBeInstanceOf(
      DecryptionError,
    );
    await expect(decryptSecret("v2.a.b", "key")).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it("refuses to encrypt without a key", async () => {
    await expect(encryptSecret("x", "")).rejects.toBeInstanceOf(
      EncryptionKeyError,
    );
  });
});
