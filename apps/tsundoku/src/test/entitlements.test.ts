import { describe, expect, it } from "vitest";
import {
  canUseAi,
  enforceAiAccess,
  LLM_UNLOCK_PRICE_USD,
  resolveUserTier,
} from "../lib/entitlements";

describe("resolveUserTier", () => {
  it("treats anonymous callers as free-unregistered", () => {
    expect(resolveUserTier({ userId: null, hasLlmUnlock: false })).toBe(
      "free-unregistered",
    );
    expect(resolveUserTier({ userId: undefined, hasLlmUnlock: false })).toBe(
      "free-unregistered",
    );
  });

  it("treats a signed-in caller without the unlock as free-registered", () => {
    expect(resolveUserTier({ userId: "u1", hasLlmUnlock: false })).toBe(
      "free-registered",
    );
  });

  it("treats a signed-in caller with the unlock as paid-registered", () => {
    expect(resolveUserTier({ userId: "u1", hasLlmUnlock: true })).toBe(
      "paid-registered",
    );
  });

  it("ignores the unlock flag for an anonymous caller", () => {
    // A stale/forged unlock on a signed-out request must never grant AI access.
    expect(resolveUserTier({ userId: null, hasLlmUnlock: true })).toBe(
      "free-unregistered",
    );
  });
});

describe("canUseAi", () => {
  it("allows only the paid-registered tier", () => {
    expect(canUseAi("paid-registered")).toBe(true);
    expect(canUseAi("free-registered")).toBe(false);
    expect(canUseAi("free-unregistered")).toBe(false);
  });
});

describe("enforceAiAccess", () => {
  it("returns null (allow) for a paid-registered caller", () => {
    expect(enforceAiAccess({ userId: "u1", hasLlmUnlock: true })).toBeNull();
  });

  it("returns 401 UNAUTHENTICATED for an anonymous caller", async () => {
    const response = enforceAiAccess({ userId: null, hasLlmUnlock: false });
    expect(response?.status).toBe(401);
    await expect(response?.json()).resolves.toMatchObject({
      error: "UNAUTHENTICATED",
    });
  });

  it("returns 403 LLM_LOCKED for a signed-in caller without the unlock", async () => {
    const response = enforceAiAccess({ userId: "u1", hasLlmUnlock: false });
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({
      error: "LLM_LOCKED",
    });
  });

  it("advertises the $0.99 unlock price in the denial message", async () => {
    const response = enforceAiAccess({ userId: "u1", hasLlmUnlock: false });
    const body = (await response?.json()) as { message: string };
    expect(body.message).toContain(`$${LLM_UNLOCK_PRICE_USD}`);
  });
});
