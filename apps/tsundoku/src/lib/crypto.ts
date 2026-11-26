/**
 * Symmetric encryption for secrets at rest (currently the per-user Google
 * refresh token). Uses WebCrypto AES-GCM with a key derived from the
 * `SHEET_TOKEN_ENCRYPTION_KEY` Worker secret, so the same code runs on
 * `workerd` and in Node during tests. Raw tokens/keys are never logged.
 */

/** Raised when the encryption secret is missing or unusable. */
export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionKeyError";
  }
}

/** Raised when a stored payload cannot be decrypted or is malformed. */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

const VERSION = "v1";
const IV_BYTES = 12;

/** Encode bytes as unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode an unpadded base64url string back into bytes. */
export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Validate that the encryption secret is present. Callers should surface a
 * clear configuration error rather than encrypt with an empty key.
 */
export function requireEncryptionKey(key: string | undefined): string {
  if (typeof key !== "string" || key.trim() === "") {
    throw new EncryptionKeyError(
      "SHEET_TOKEN_ENCRYPTION_KEY is not configured; refusing to store or read Google credentials.",
    );
  }
  return key;
}

/** Derive a 256-bit AES-GCM key from the secret via SHA-256. */
async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypt `plaintext`, returning a self-describing `v1.<iv>.<ciphertext>`
 * payload (both segments base64url). A fresh random IV is used per call.
 */
export async function encryptSecret(
  plaintext: string,
  secret: string,
): Promise<string> {
  const key = await deriveKey(requireEncryptionKey(secret));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

/** Decrypt a payload produced by {@link encryptSecret}. */
export async function decryptSecret(
  payload: string,
  secret: string,
): Promise<string> {
  const parts = payload.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new DecryptionError("Unsupported encrypted payload format.");
  }
  const [, ivPart, ciphertextPart] = parts;
  if (!ivPart || !ciphertextPart) {
    throw new DecryptionError("Encrypted payload is incomplete.");
  }

  const key = await deriveKey(requireEncryptionKey(secret));
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(ivPart) },
      key,
      fromBase64Url(ciphertextPart),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // A wrong key or tampered payload fails the GCM auth tag here.
    throw new DecryptionError("Could not decrypt the stored credential.");
  }
}
