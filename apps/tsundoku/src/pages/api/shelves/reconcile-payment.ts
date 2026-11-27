import type { APIContext, APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  addCredit,
  type CreditPayment,
  getPaymentByReference,
  markPaymentStatus,
} from "../../../lib/credits";
import {
  LLM_UNLOCK_CURRENCY,
  LLM_UNLOCK_PRICE_USD,
} from "../../../lib/entitlements";
import {
  getHitPayPaymentRequest,
  type HitPayPaymentRequestDetails,
} from "../../../lib/hitpay";
import { errorResponse, jsonResponse } from "../../../lib/http";
import { parseUnlockReference } from "../../../lib/llm-entitlement";

export const prerender = false;

/** Tolerated absolute difference when matching the paid amount to the price. */
const AMOUNT_EPSILON = 0.001;

/**
 * Overridable server-side configuration for the return-time reconcile. Every
 * D1 accessor, the HitPay status lookup, and the expected amount/currency are
 * injectable so tests never touch the live network, secrets, or D1.
 */
export interface ReconcilePaymentDependencies {
  /** The authenticated user's id, or `null`/`undefined` when anonymous. */
  userId?: string | null;
  /** Payment `reference_number`; when unset the JSON body's `reference` is used. */
  reference?: string | null;
  /** HitPay business API key (`HITPAY_API_KEY`). */
  hitpayApiKey?: string;
  /** HitPay versioned base URL (`HITPAY_API_URL`). */
  hitpayApiUrl?: string;
  /** Expected amount; defaults to {@link LLM_UNLOCK_PRICE_USD}. */
  expectedAmount?: number;
  /** Expected currency; defaults to {@link LLM_UNLOCK_CURRENCY}. */
  expectedCurrency?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Read the persisted payment row by reference. */
  getPayment?: (reference: string) => Promise<CreditPayment | null>;
  /** Idempotently add credit for a fulfilled payment. */
  addCredit?: (
    userId: string,
    input: { amount: number; reference: string },
  ) => Promise<{ credited: boolean; balance: number }>;
  /** Update a payment row's status. */
  markPayment?: (
    id: string,
    status: string,
    creditedAt?: string | null,
  ) => Promise<void>;
  /** Injectable HitPay status lookup (defaults to the real client). */
  getPaymentRequest?: typeof getHitPayPaymentRequest;
}

/**
 * Testable `POST /api/shelves/reconcile-payment` handler.
 *
 * The scanner calls this after HitPay redirects the shopper back, so the credit
 * is granted even when the deprecated per-request webhook is never delivered:
 * it loads the pending payment persisted at checkout and confirms its real
 * status via HitPay's `GET /payment-requests/{id}` API. A confirmed payment
 * credits the ledger idempotently (keyed by the unique reference). The response
 * carries the resulting status + balance so the UI can show clear feedback.
 */
export async function handleReconcilePayment(
  context: Pick<APIContext, "request">,
  dependencies: ReconcilePaymentDependencies = {},
): Promise<Response> {
  const userId = dependencies.userId;
  if (!userId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to confirm your payment.");
  }

  let body: { reference?: unknown } = {};
  try {
    body = (await context.request.json()) as { reference?: unknown };
  } catch {
    body = {};
  }
  const reference =
    typeof body.reference === "string" && body.reference !== ""
      ? body.reference
      : (dependencies.reference ?? null);
  if (!reference) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "Provide the payment reference to confirm.",
    );
  }

  // The reference embeds the paying user's id; a caller may never reconcile
  // someone else's payment.
  if (parseUnlockReference(reference) !== userId) {
    return errorResponse(
      403,
      "FORBIDDEN",
      "That payment does not belong to your account.",
    );
  }

  const getPayment =
    dependencies.getPayment ?? ((ref: string) => getPaymentByReference(env.DB, ref));
  const addCreditFn =
    dependencies.addCredit ?? ((uid, input) => addCredit(env.DB, uid, input));
  const markPayment =
    dependencies.markPayment ??
    ((id, status, creditedAt) => markPaymentStatus(env.DB, id, status, creditedAt));

  let payment: CreditPayment | null;
  try {
    payment = await getPayment(reference);
  } catch (error) {
    console.error(
      "[reconcile-payment] failed to read payment:",
      error instanceof Error ? error.message : error,
    );
    return errorResponse(500, "UPSTREAM_ERROR", "Could not read the payment.");
  }

  if (!payment) {
    // No persisted record (e.g. the checkout's best-effort write failed, or the
    // payment predates this flow). Report it honestly rather than guessing.
    return jsonResponse({
      ok: true,
      status: "unknown",
      message: "No matching payment was found for this reference.",
    });
  }

  const expectedAmount = dependencies.expectedAmount ?? LLM_UNLOCK_PRICE_USD;
  const expectedCurrency = (
    dependencies.expectedCurrency ?? LLM_UNLOCK_CURRENCY
  ).toUpperCase();

  // Already confirmed on a previous call/webhook — re-adding is idempotent.
  if (payment.status === "completed") {
    const result = await addCreditFn(userId, {
      amount: payment.amount,
      reference,
    });
    return jsonResponse({
      ok: true,
      status: "completed",
      credited: result.credited,
      balance: result.balance,
      amount: payment.amount,
    });
  }

  if (!dependencies.hitpayApiKey || !dependencies.hitpayApiUrl) {
    return errorResponse(
      503,
      "CONFIG_ERROR",
      "Payment confirmation is not configured on this deployment.",
    );
  }

  const lookup = dependencies.getPaymentRequest ?? getHitPayPaymentRequest;
  let details: HitPayPaymentRequestDetails;
  try {
    details = await lookup(
      {
        apiKey: dependencies.hitpayApiKey,
        baseUrl: dependencies.hitpayApiUrl,
        fetchImpl: dependencies.fetchImpl,
        timeoutMs: dependencies.timeoutMs,
      },
      payment.id,
    );
  } catch (error) {
    console.warn(
      "[reconcile-payment] HitPay status lookup failed:",
      error instanceof Error ? error.message : error,
    );
    return errorResponse(
      502,
      "UPSTREAM_ERROR",
      "Could not confirm the payment with HitPay. Please try again shortly.",
    );
  }

  if (details.status === "completed") {
    const paidAmount = details.amount ?? payment.amount;
    const paidCurrency = (
      details.currency ??
      payment.currency ??
      expectedCurrency
    ).toUpperCase();
    if (
      Math.abs(paidAmount - expectedAmount) > AMOUNT_EPSILON ||
      paidCurrency !== expectedCurrency
    ) {
      console.warn("[reconcile-payment] amount/currency mismatch; not crediting", {
        paidAmount,
        paidCurrency,
        expectedAmount,
        expectedCurrency,
      });
      await markPayment(payment.id, "failed");
      return jsonResponse({ ok: true, status: "failed", reason: "amount_mismatch" });
    }

    const result = await addCreditFn(userId, {
      amount: expectedAmount,
      reference,
    });
    await markPayment(payment.id, "completed", new Date().toISOString());
    return jsonResponse({
      ok: true,
      status: "completed",
      credited: result.credited,
      balance: result.balance,
      amount: expectedAmount,
    });
  }

  if (details.status === "pending") {
    return jsonResponse({ ok: true, status: "pending" });
  }

  // failed | expired | canceled | inactive — record and surface honestly.
  await markPayment(payment.id, details.status);
  return jsonResponse({ ok: true, status: details.status });
}

/** Production route: requires a session and wires the real `env` + D1. */
export const POST: APIRoute = async (context) => {
  const user = context.locals.user;
  return handleReconcilePayment(context, {
    userId: user?.id ?? null,
    hitpayApiKey: env.HITPAY_API_KEY,
    hitpayApiUrl: env.HITPAY_API_URL,
    expectedCurrency: env.HITPAY_CURRENCY ?? LLM_UNLOCK_CURRENCY,
  });
};
