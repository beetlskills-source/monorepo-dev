import { describe, expect, it, vi } from "vitest";
import type { APIContext } from "astro";

/** Stub the Workers-only module so the route module imports under Node. */
vi.mock("cloudflare:workers", () => ({ env: {} }));

const { handleHitPayWebhook } = await import("../pages/api/webhooks/hitpay");

const SALT = "webhook-salt";

/** Compute the HMAC-SHA256 (lowercase hex) HitPay sends in `Hitpay-Signature`. */
async function sign(salt: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

type Ctx = Pick<APIContext, "request">;

function makeContext(body: string, signature?: string): Ctx {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== undefined) headers.set("hitpay-signature", signature);
  return {
    request: new Request("https://tsundoku.test/api/webhooks/hitpay", {
      method: "POST",
      headers,
      body,
    }),
  };
}

function completedBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: "completed",
    reference_number: "llmunlock:user-9",
    amount: "0.99",
    currency: "USD",
    ...overrides,
  });
}

describe("handleHitPayWebhook — verification", () => {
  it("returns 503 when the salt is not configured", async () => {
    const fulfil = vi.fn();
    const response = await handleHitPayWebhook(makeContext("{}", "abc"), {
      fulfil,
    });
    expect(response.status).toBe(503);
    expect(fulfil).not.toHaveBeenCalled();
  });

  it("returns 401 and never credits when the signature is invalid", async () => {
    const body = completedBody();
    const badSignature = await sign("wrong-salt", body);
    const fulfil = vi.fn();

    const response = await handleHitPayWebhook(makeContext(body, badSignature), {
      salt: SALT,
      fulfil,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: "UNAUTHENTICATED",
    });
    expect(fulfil).not.toHaveBeenCalled();
  });

  it("returns 400 for a body that is not JSON (signature still verified)", async () => {
    const body = "not-json";
    const signature = await sign(SALT, body);
    const response = await handleHitPayWebhook(makeContext(body, signature), {
      salt: SALT,
      fulfil: vi.fn(),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "INVALID_REQUEST",
    });
  });
});

describe("handleHitPayWebhook — fulfilment", () => {
  it("credits the top-up for a completed payment", async () => {
    const body = completedBody();
    const signature = await sign(SALT, body);
    const fulfil = vi.fn(async () => ({ credited: true, balance: 0.99 }));

    const response = await handleHitPayWebhook(makeContext(body, signature), {
      salt: SALT,
      fulfil,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      credited: true,
      balance: 0.99,
    });
    // The userId is parsed out of the reference and the amount/currency are the
    // expected ones, so a mis-sized payment can never reach the ledger.
    expect(fulfil).toHaveBeenCalledWith({
      userId: "user-9",
      reference: "llmunlock:user-9",
      amount: 0.99,
      currency: "USD",
    });
  });

  it("reports credited:false when the ledger already holds the reference", async () => {
    const body = completedBody();
    const signature = await sign(SALT, body);
    const fulfil = vi.fn(async () => ({ credited: false, balance: 0.99 }));

    const response = await handleHitPayWebhook(makeContext(body, signature), {
      salt: SALT,
      fulfil,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      credited: false,
      balance: 0.99,
    });
  });

  it("is idempotent — replaying the same webhook succeeds twice", async () => {
    const body = completedBody();
    const signature = await sign(SALT, body);
    const fulfil = vi.fn(async () => ({ credited: true, balance: 0.99 }));

    const first = await handleHitPayWebhook(makeContext(body, signature), {
      salt: SALT,
      fulfil,
    });
    const second = await handleHitPayWebhook(makeContext(body, signature), {
      salt: SALT,
      fulfil,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fulfil).toHaveBeenCalledTimes(2);
  });

  it("acknowledges a non-completed status without crediting", async () => {
    const body = completedBody({ status: "failed" });
    const signature = await sign(SALT, body);
    const fulfil = vi.fn();

    const response = await handleHitPayWebhook(makeContext(body, signature), {
      salt: SALT,
      fulfil,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      ignored: true,
    });
    expect(fulfil).not.toHaveBeenCalled();
  });

  it("ignores a completed payment whose reference is not an unlock", async () => {
    const body = completedBody({ reference_number: "order:123" });
    const signature = await sign(SALT, body);
    const fulfil = vi.fn();

    const response = await handleHitPayWebhook(makeContext(body, signature), {
      salt: SALT,
      fulfil,
    });

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      ignored: true,
      reason: "unknown_reference",
    });
    expect(fulfil).not.toHaveBeenCalled();
  });

  it("refuses to credit when the paid amount does not match", async () => {
    const body = completedBody({ amount: "9.99" });
    const signature = await sign(SALT, body);
    const fulfil = vi.fn();

    const response = await handleHitPayWebhook(makeContext(body, signature), {
      salt: SALT,
      fulfil,
    });

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      ignored: true,
      reason: "amount_mismatch",
    });
    expect(fulfil).not.toHaveBeenCalled();
  });

  it("returns 500 so HitPay retries when the D1 write fails", async () => {
    const body = completedBody();
    const signature = await sign(SALT, body);
    const fulfil = vi.fn(async () => {
      throw new Error("d1 down");
    });

    const response = await handleHitPayWebhook(makeContext(body, signature), {
      salt: SALT,
      fulfil,
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: "UPSTREAM_ERROR",
    });
  });
});
