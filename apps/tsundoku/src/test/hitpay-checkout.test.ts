import { describe, expect, it, vi } from "vitest";
import type { APIContext } from "astro";
import type { CreatePaymentRequestInput } from "../lib/hitpay";
import type { ShelfEntitlement } from "../lib/llm-entitlement";

/** Stub the Workers-only module so the route modules import under Node. */
vi.mock("cloudflare:workers", () => ({ env: {} }));

const { handleCheckout } = await import("../pages/api/shelves/checkout");
const { handleEntitlement } = await import("../pages/api/shelves/entitlement");

type Ctx = Pick<APIContext, "request">;

function makeContext(
  url = "https://tsundoku.test/api/shelves/checkout",
): Ctx {
  return { request: new Request(url, { method: "POST" }) };
}

/** A payment-request creator double that records the input it was given. */
function recordingCreate() {
  const calls: CreatePaymentRequestInput[] = [];
  const create = vi.fn(async (_config: unknown, input: CreatePaymentRequestInput) => {
    calls.push(input);
    return {
      id: "pr_1",
      url: "https://securecheckout.test/pr_1",
      status: "pending",
      referenceNumber: input.referenceNumber,
    };
  });
  return { calls, create };
}

describe("handleCheckout — entitlement & config", () => {
  it("returns 401 for an anonymous caller", async () => {
    const { create } = recordingCreate();
    const response = await handleCheckout(makeContext(), {
      userId: null,
      hitpayApiKey: "k",
      hitpayApiUrl: "https://api.sandbox.hit-pay.com/v1",
      createPaymentRequest: create,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: "UNAUTHENTICATED",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 503 when HitPay is not configured", async () => {
    const response = await handleCheckout(makeContext(), { userId: "u1" });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "CONFIG_ERROR" });
  });

  it("allows a repeat top-up: a user with existing credit is charged again", async () => {
    const { calls, create } = recordingCreate();
    const response = await handleCheckout(makeContext(), {
      userId: "u1",
      hitpayApiKey: "k",
      hitpayApiUrl: "https://api.sandbox.hit-pay.com/v1",
      createPaymentRequest: create,
      nonce: "repeat-1",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      url: "https://securecheckout.test/pr_1",
    });
    // A fresh payment request is created every time (no short-circuit), so the
    // "Top up AI credits" button always produces a real checkout.
    expect(create).toHaveBeenCalledTimes(1);
    expect(calls[0]?.referenceNumber).toBe("llmunlock:u1:repeat-1");
  });
});

describe("handleCheckout — payment request", () => {
  it("tags the request with the user id and app URLs, then returns the url", async () => {
    const { calls, create } = recordingCreate();
    const response = await handleCheckout(makeContext(), {
      userId: "user-42",
      email: "buyer@example.com",
      hitpayApiKey: "k",
      hitpayApiUrl: "https://api.sandbox.hit-pay.com/v1",
      appOrigin: "https://app.test",
      createPaymentRequest: create,
      nonce: "nonce-1",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      url: "https://securecheckout.test/pr_1",
      currency: "USD",
      amount: 0.99,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      amount: 0.99,
      currency: "USD",
      referenceNumber: "llmunlock:user-42:nonce-1",
      // The unique reference rides in the return URL so the return-time
      // reconcile can look the payment up even if no webhook is delivered.
      redirectUrl:
        "https://app.test/?unlock=return&ref=llmunlock%3Auser-42%3Anonce-1",
      webhookUrl: "https://app.test/api/webhooks/hitpay",
      email: "buyer@example.com",
    });
  });

  it("persists a pending payment keyed by the unique reference", async () => {
    const { create } = recordingCreate();
    const recordPayment = vi.fn(async () => {});
    await handleCheckout(makeContext(), {
      userId: "user-7",
      hitpayApiKey: "k",
      hitpayApiUrl: "https://api.sandbox.hit-pay.com/v1",
      createPaymentRequest: create,
      recordPayment,
      nonce: "abc",
    });

    expect(recordPayment).toHaveBeenCalledWith({
      id: "pr_1",
      userId: "user-7",
      reference: "llmunlock:user-7:abc",
      amount: 0.99,
      currency: "USD",
    });
  });

  it("still returns the url when persisting the pending payment fails", async () => {
    const { create } = recordingCreate();
    const recordPayment = vi.fn(async () => {
      throw new Error("d1 down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await handleCheckout(makeContext(), {
        userId: "user-7",
        hitpayApiKey: "k",
        hitpayApiUrl: "https://api.sandbox.hit-pay.com/v1",
        createPaymentRequest: create,
        recordPayment,
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        url: "https://securecheckout.test/pr_1",
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("derives the app origin from the request URL when unset", async () => {
    const { calls, create } = recordingCreate();
    await handleCheckout(makeContext("https://tsundoku.example/checkout"), {
      userId: "user-1",
      hitpayApiKey: "k",
      hitpayApiUrl: "https://api.sandbox.hit-pay.com/v1",
      createPaymentRequest: create,
      nonce: "n1",
    });

    expect(calls[0]?.redirectUrl).toBe(
      "https://tsundoku.example/?unlock=return&ref=llmunlock%3Auser-1%3An1",
    );
    expect(calls[0]?.webhookUrl).toBe(
      "https://tsundoku.example/api/webhooks/hitpay",
    );
  });

  it("uses a sanitised return path so /settings receives the redirect", async () => {
    const { calls, create } = recordingCreate();
    await handleCheckout(makeContext(), {
      userId: "user-1",
      hitpayApiKey: "k",
      hitpayApiUrl: "https://api.sandbox.hit-pay.com/v1",
      appOrigin: "https://app.test",
      createPaymentRequest: create,
      returnPath: "/settings",
      nonce: "n1",
    });

    expect(calls[0]?.redirectUrl).toBe(
      "https://app.test/settings?unlock=return&ref=llmunlock%3Auser-1%3An1",
    );
  });

  it("ignores an off-origin return path", async () => {
    const { calls, create } = recordingCreate();
    await handleCheckout(makeContext(), {
      userId: "user-1",
      hitpayApiKey: "k",
      hitpayApiUrl: "https://api.sandbox.hit-pay.com/v1",
      appOrigin: "https://app.test",
      createPaymentRequest: create,
      returnPath: "//evil.test/steal",
      nonce: "n1",
    });

    expect(calls[0]?.redirectUrl).toBe(
      "https://app.test/?unlock=return&ref=llmunlock%3Auser-1%3An1",
    );
  });

  it("returns 502 when HitPay rejects the request", async () => {
    const create = vi.fn(async () => {
      throw new Error("upstream down");
    });
    const response = await handleCheckout(makeContext(), {
      userId: "u1",
      hitpayApiKey: "k",
      hitpayApiUrl: "https://api.sandbox.hit-pay.com/v1",
      createPaymentRequest: create,
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: "UPSTREAM_ERROR",
    });
  });
});

describe("handleEntitlement", () => {
  it("reports a locked, signed-out payload for anonymous callers", async () => {
    const response = await handleEntitlement({ userId: null });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      signedIn: false,
      hasLlmUnlock: false,
      enrichWithLlm: false,
      creditBalance: 0,
    });
  });

  it("reads the entitlement through the injected single-source reader", async () => {
    const readEntitlement = vi.fn(
      async (): Promise<ShelfEntitlement> => ({
        hasLlmUnlock: true,
        enrichWithLlm: false,
        creditBalance: 0.99,
      }),
    );

    const response = await handleEntitlement({ userId: "u1", readEntitlement });
    await expect(response.json()).resolves.toEqual({
      signedIn: true,
      hasLlmUnlock: true,
      enrichWithLlm: false,
      creditBalance: 0.99,
    });
    expect(readEntitlement).toHaveBeenCalledWith("u1");
  });
});
