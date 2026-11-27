import { describe, expect, it } from "vitest";
import {
  createHitPayPaymentRequest,
  HitPayError,
  verifyHitPaySignature,
} from "../lib/hitpay";

/** Compute a HitPay-style HMAC-SHA256 (lowercase hex) for test fixtures. */
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

describe("verifyHitPaySignature", () => {
  const salt = "test-salt";
  const body = JSON.stringify({ status: "completed" });

  it("accepts a signature produced with the same salt and body", async () => {
    const signature = await sign(salt, body);
    await expect(verifyHitPaySignature(salt, body, signature)).resolves.toBe(true);
  });

  it("accepts an upper-case signature", async () => {
    const signature = (await sign(salt, body)).toUpperCase();
    await expect(verifyHitPaySignature(salt, body, signature)).resolves.toBe(true);
  });

  it("rejects a signature from a different salt (tampered payload)", async () => {
    const signature = await sign("other-salt", body);
    await expect(verifyHitPaySignature(salt, body, signature)).resolves.toBe(false);
  });

  it("rejects a signature over a different body", async () => {
    const signature = await sign(salt, JSON.stringify({ status: "failed" }));
    await expect(verifyHitPaySignature(salt, body, signature)).resolves.toBe(false);
  });

  it("returns false for a missing salt or signature", async () => {
    await expect(verifyHitPaySignature(undefined, body, "abc")).resolves.toBe(false);
    await expect(verifyHitPaySignature(salt, body, null)).resolves.toBe(false);
    await expect(verifyHitPaySignature(salt, body, "   ")).resolves.toBe(false);
  });
});

describe("createHitPayPaymentRequest", () => {
  const config = {
    apiKey: "api-key-123",
    baseUrl: "https://api.sandbox.hit-pay.com/v1",
  };

  const input = {
    amount: 0.99,
    currency: "USD",
    referenceNumber: "llmunlock:user-1",
    redirectUrl: "https://app.test/?unlock=return",
    webhookUrl: "https://app.test/api/webhooks/hitpay",
    email: "buyer@example.com",
    name: "Buyer",
    purpose: "Tsundoku — AI unlock",
  };

  it("POSTs the expected body + auth header and returns the checkout url", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          id: "pr_123",
          url: "https://securecheckout.sandbox.hit-pay.com/payment-request/x",
          status: "pending",
          reference_number: "llmunlock:user-1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await createHitPayPaymentRequest(
      { ...config, fetchImpl },
      input,
    );

    expect(capturedUrl).toBe(
      "https://api.sandbox.hit-pay.com/v1/payment-requests",
    );
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["X-BUSINESS-API-KEY"]).toBe("api-key-123");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(String(capturedInit?.body));
    expect(body).toMatchObject({
      amount: 0.99,
      currency: "USD",
      reference_number: "llmunlock:user-1",
      redirect_url: "https://app.test/?unlock=return",
      webhook: "https://app.test/api/webhooks/hitpay",
      email: "buyer@example.com",
    });
    // Optional method allow-list is omitted so the account defaults apply.
    expect(body.payment_methods).toBeUndefined();

    expect(result).toEqual({
      id: "pr_123",
      url: "https://securecheckout.sandbox.hit-pay.com/payment-request/x",
      status: "pending",
      referenceNumber: "llmunlock:user-1",
    });
  });

  it("trims a trailing slash from the base URL", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = (async (url: RequestInfo | URL) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ id: "p", url: "https://pay.test/x" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await createHitPayPaymentRequest(
      { apiKey: "k", baseUrl: "https://api.hit-pay.com/v1/", fetchImpl },
      input,
    );
    expect(capturedUrl).toBe("https://api.hit-pay.com/v1/payment-requests");
  });

  it("throws a HitPayError on a non-2xx response", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: "Invalid API key" }), {
        status: 401,
      })) as unknown as typeof fetch;

    await expect(
      createHitPayPaymentRequest({ ...config, fetchImpl }, input),
    ).rejects.toBeInstanceOf(HitPayError);
  });

  it("throws when the response has no checkout url", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ id: "p" }), { status: 200 })) as unknown as typeof fetch;

    await expect(
      createHitPayPaymentRequest({ ...config, fetchImpl }, input),
    ).rejects.toThrow(/checkout url/i);
  });

  it("wraps a network failure in a HitPayError", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;

    await expect(
      createHitPayPaymentRequest({ ...config, fetchImpl }, input),
    ).rejects.toBeInstanceOf(HitPayError);
  });
});
