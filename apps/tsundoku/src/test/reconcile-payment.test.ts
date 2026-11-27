import { describe, expect, it, vi } from "vitest";
import type { APIContext } from "astro";
import type { HitPayPaymentRequestDetails } from "../lib/hitpay";
import type { CreditPayment } from "../lib/credits";

/** Stub the Workers-only module so the route module imports under Node. */
vi.mock("cloudflare:workers", () => ({ env: {} }));

const { handleReconcilePayment } = await import(
  "../pages/api/shelves/reconcile-payment"
);
type ReconcilePaymentDependencies = import(
  "../pages/api/shelves/reconcile-payment"
).ReconcilePaymentDependencies;

type Ctx = Pick<APIContext, "request">;

const REF = "llmunlock:user-9:abc";

function makeContext(body: unknown = { reference: REF }): Ctx {
  return {
    request: new Request(
      "https://tsundoku.test/api/shelves/reconcile-payment",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  };
}

function payment(overrides: Partial<CreditPayment> = {}): CreditPayment {
  return {
    id: "pr_1",
    userId: "user-9",
    reference: REF,
    amount: 0.99,
    currency: "USD",
    status: "pending",
    creditedAt: null,
    createdAt: "t0",
    updatedAt: "t1",
    ...overrides,
  };
}

function details(
  overrides: Partial<HitPayPaymentRequestDetails> = {},
): HitPayPaymentRequestDetails {
  return {
    id: "pr_1",
    status: "completed",
    amount: 0.99,
    currency: "USD",
    referenceNumber: REF,
    ...overrides,
  };
}

/** Configuration that wires every HitPay config + injectable dependency. */
function baseDeps(
  overrides: Partial<ReconcilePaymentDependencies> = {},
): ReconcilePaymentDependencies {
  return {
    userId: "user-9",
    hitpayApiKey: "k",
    hitpayApiUrl: "https://api.sandbox.hit-pay.com/v1",
    getPayment: vi.fn(async () => payment()),
    addCredit: vi.fn(async () => ({ credited: true, balance: 0.99 })),
    markPayment: vi.fn(async () => {}),
    getPaymentRequest: vi.fn(async () => details()),
    ...overrides,
  };
}

describe("handleReconcilePayment — guards", () => {
  it("returns 401 for an anonymous caller", async () => {
    const response = await handleReconcilePayment(makeContext(), {
      userId: null,
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: "UNAUTHENTICATED",
    });
  });

  it("returns 400 when no reference is supplied", async () => {
    const response = await handleReconcilePayment(makeContext({}), {
      userId: "user-9",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "INVALID_REQUEST",
    });
  });

  it("returns 403 when the reference belongs to another user", async () => {
    const response = await handleReconcilePayment(makeContext(), {
      userId: "someone-else",
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "FORBIDDEN" });
  });

  it("reports unknown for a reference with no persisted payment", async () => {
    const response = await handleReconcilePayment(
      makeContext(),
      baseDeps({ getPayment: vi.fn(async () => null) }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: "unknown",
    });
  });
});

describe("handleReconcilePayment — confirmation", () => {
  it("credits an already-completed payment idempotently without re-querying HitPay", async () => {
    const expectLookup = vi.fn(async () => details());
    const response = await handleReconcilePayment(
      makeContext(),
      baseDeps({
        getPayment: vi.fn(async () => payment({ status: "completed" })),
        addCredit: vi.fn(async () => ({ credited: false, balance: 0.99 })),
        getPaymentRequest: expectLookup,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: "completed",
      credited: false,
      balance: 0.99,
      amount: 0.99,
    });
    expect(expectLookup).not.toHaveBeenCalled();
  });

  it("confirms a completed payment with HitPay and credits + marks it", async () => {
    const addCredit = vi.fn(async () => ({ credited: true, balance: 0.99 }));
    const markPayment = vi.fn(async () => {});
    const response = await handleReconcilePayment(
      makeContext(),
      baseDeps({ addCredit, markPayment }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: "completed",
      credited: true,
      balance: 0.99,
      amount: 0.99,
    });
    expect(addCredit).toHaveBeenCalledWith("user-9", {
      amount: 0.99,
      reference: REF,
    });
    expect(markPayment).toHaveBeenCalledWith("pr_1", "completed", expect.any(String));
  });

  it("reports pending without crediting when HitPay still says pending", async () => {
    const addCredit = vi.fn(async () => ({ credited: true, balance: 0.99 }));
    const response = await handleReconcilePayment(
      makeContext(),
      baseDeps({
        getPaymentRequest: vi.fn(async () => details({ status: "pending" })),
        addCredit,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: "pending",
    });
    expect(addCredit).not.toHaveBeenCalled();
  });

  it("refuses to credit a mis-sized payment and marks it failed", async () => {
    const addCredit = vi.fn(async () => ({ credited: true, balance: 0.99 }));
    const markPayment = vi.fn(async () => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await handleReconcilePayment(
        makeContext(),
        baseDeps({
          getPaymentRequest: vi.fn(async () => details({ amount: 9.99 })),
          addCredit,
          markPayment,
        }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        status: "failed",
        reason: "amount_mismatch",
      });
      expect(addCredit).not.toHaveBeenCalled();
      expect(markPayment).toHaveBeenCalledWith("pr_1", "failed");
    } finally {
      warn.mockRestore();
    }
  });

  it("records a non-completed HitPay status honestly", async () => {
    const markPayment = vi.fn(async () => {});
    const response = await handleReconcilePayment(
      makeContext(),
      baseDeps({
        getPaymentRequest: vi.fn(async () => details({ status: "expired" })),
        markPayment,
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: "expired",
    });
    expect(markPayment).toHaveBeenCalledWith("pr_1", "expired");
  });

  it("returns 503 when HitPay is not configured", async () => {
    const response = await handleReconcilePayment(makeContext(), {
      userId: "user-9",
      getPayment: vi.fn(async () => payment()),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "CONFIG_ERROR" });
  });

  it("returns 502 when the HitPay status lookup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await handleReconcilePayment(
        makeContext(),
        baseDeps({
          getPaymentRequest: vi.fn(async () => {
            throw new Error("hitpay down");
          }),
        }),
      );
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        error: "UPSTREAM_ERROR",
      });
    } finally {
      warn.mockRestore();
    }
  });
});
