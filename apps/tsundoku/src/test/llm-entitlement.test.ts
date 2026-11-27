import { describe, expect, it, vi, beforeEach } from "vitest";

/** Stub the D1 accessors so the entitlement helper is tested in isolation. */
vi.mock("../lib/shelf-configs", () => ({
  getShelfConfig: vi.fn(),
  upsertShelfConfig: vi.fn(),
}));
vi.mock("../lib/credits", () => ({
  getCreditBalance: vi.fn(),
}));

const { getShelfConfig } = await import("../lib/shelf-configs");
const { getCreditBalance } = await import("../lib/credits");
const {
  buildUnlockReference,
  isLlmUnlocked,
  parseUnlockReference,
  readShelfEntitlement,
} = await import("../lib/llm-entitlement");

const db = {} as D1Database;

beforeEach(() => {
  vi.mocked(getShelfConfig).mockReset();
  vi.mocked(getCreditBalance).mockReset();
});

describe("readShelfEntitlement", () => {
  it("derives hasLlmUnlock from a positive credit balance", async () => {
    vi.mocked(getShelfConfig).mockResolvedValue({ enrichWithLlm: true } as never);
    vi.mocked(getCreditBalance).mockResolvedValue(0.99);

    await expect(readShelfEntitlement(db, "u1")).resolves.toEqual({
      hasLlmUnlock: true,
      enrichWithLlm: true,
      creditBalance: 0.99,
    });
  });

  it("reports the AI features locked when the credit balance is zero", async () => {
    vi.mocked(getShelfConfig).mockResolvedValue({ enrichWithLlm: false } as never);
    vi.mocked(getCreditBalance).mockResolvedValue(0);

    await expect(readShelfEntitlement(db, "u1")).resolves.toEqual({
      hasLlmUnlock: false,
      enrichWithLlm: false,
      creditBalance: 0,
    });
  });

  it("returns locked defaults when there is no shelf_configs row", async () => {
    vi.mocked(getShelfConfig).mockResolvedValue(null);
    vi.mocked(getCreditBalance).mockResolvedValue(0);

    await expect(readShelfEntitlement(db, "u1")).resolves.toEqual({
      hasLlmUnlock: false,
      enrichWithLlm: false,
      creditBalance: 0,
    });
  });

  it("fails closed when a D1 read throws (e.g. unapplied migration)", async () => {
    vi.mocked(getShelfConfig).mockRejectedValue(new Error("no such column"));

    await expect(readShelfEntitlement(db, "u1")).resolves.toEqual({
      hasLlmUnlock: false,
      enrichWithLlm: false,
      creditBalance: 0,
    });
    await expect(isLlmUnlocked(db, "u1")).resolves.toBe(false);
  });
});

describe("isLlmUnlocked", () => {
  it("is true only while credit remains", async () => {
    vi.mocked(getShelfConfig).mockResolvedValue(null);
    vi.mocked(getCreditBalance).mockResolvedValue(0.5);
    await expect(isLlmUnlocked(db, "u1")).resolves.toBe(true);
  });
});

describe("unlock reference helpers", () => {
  it("round-trips a user id through the HitPay reference_number", () => {
    const reference = buildUnlockReference("user-123");
    expect(reference).toBe("llmunlock:user-123");
    expect(parseUnlockReference(reference)).toBe("user-123");
  });

  it("appends a per-payment nonce yet still parses the user id", () => {
    const reference = buildUnlockReference("user-123", "nonce-1");
    expect(reference).toBe("llmunlock:user-123:nonce-1");
    expect(parseUnlockReference(reference)).toBe("user-123");
  });

  it("rejects foreign, empty, and missing references", () => {
    expect(parseUnlockReference("order:999")).toBeNull();
    expect(parseUnlockReference("llmunlock:")).toBeNull();
    expect(parseUnlockReference(null)).toBeNull();
    expect(parseUnlockReference(undefined)).toBeNull();
  });
});
