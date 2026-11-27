import type { APIContext, APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  addCredit,
  getPaymentByReference,
  markPaymentStatus,
} from "../../../lib/credits";
import {
  LLM_UNLOCK_CURRENCY,
  LLM_UNLOCK_PRICE_USD,
} from "../../../lib/entitlements";
import {
  HITPAY_SIGNATURE_HEADER,
  verifyHitPaySignature,
} from "../../../lib/hitpay";
import { errorResponse, jsonResponse } from "../../../lib/http";
import { parseUnlockReference } from "../../../lib/llm-entitlement";

export const prerender = false;

/** Tolerated absolute difference when matching the paid amount to the price. */
const AMOUNT_EPSILON = 0.001;

/** The credit added by a fulfilled top-up. */
export interface FulfilInput {
  userId: string;
  /** Unique HitPay `reference_number`; the ledger idempotency key. */
  reference: string;
  /** Expected credit amount (USD). */
  amount: number;
  currency: string;
}

export interface FulfilResult {
  /** Whether this call actually added credit (`false` on a replayed reference). */
  credited: boolean;
  balance: number;
}

/**
 * Overridable server-side configuration for the webhook handler. The salt, the
 * expected amount/currency, and the fulfilment callback are injectable so tests
 * never touch real secrets or D1.
 */
export interface HitPayWebhookDependencies {
  /** HitPay salt used to verify `Hitpay-Signature` (`HITPAY_SALT`). */
  salt?: string;
  /** Expected amount; defaults to {@link LLM_UNLOCK_PRICE_USD}. */
  expectedAmount?: number;
  /** Expected currency; defaults to {@link LLM_UNLOCK_CURRENCY}. */
  expectedCurrency?: string;
  /** Add credit for a user; must be idempotent on the `reference`. */
  fulfil?: (input: FulfilInput) => Promise<FulfilResult>;
}

/** The subset of HitPay's payment webhook payload this handler relies on. */
interface HitPayWebhookPayload {
  status?: unknown;
  reference_number?: unknown;
  amount?: unknown;
  currency?: unknown;
}

function asAmount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Testable `POST /api/webhooks/hitpay` handler.
 *
 * Verifies the `Hitpay-Signature` HMAC **before** trusting any payload, then
 * idempotently fulfils a completed top-up by adding credit to the matching
 * user's ledger (keyed by the payment's unique `reference_number`). Non-completed
 * events, foreign references, and amount/currency mismatches are acknowledged
 * (200) without crediting, so HitPay does not retry them; a D1 write failure
 * returns 500 so HitPay retries (the credit is idempotent, so replays are safe).
 */
export async function handleHitPayWebhook(
  context: Pick<APIContext, "request">,
  dependencies: HitPayWebhookDependencies = {},
): Promise<Response> {
  if (!dependencies.salt) {
    return errorResponse(
      503,
      "CONFIG_ERROR",
      "Webhook verification is not configured.",
    );
  }

  const rawBody = await context.request.text();
  const signature = context.request.headers.get(HITPAY_SIGNATURE_HEADER);
  const valid = await verifyHitPaySignature(
    dependencies.salt,
    rawBody,
    signature,
  );
  if (!valid) {
    return errorResponse(401, "UNAUTHENTICATED", "Invalid webhook signature.");
  }

  let payload: HitPayWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as HitPayWebhookPayload;
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "Webhook body must be valid JSON.");
  }

  // Only a completed payment credits the top-up; ack everything else so HitPay
  // stops retrying pending/failed notifications.
  if (payload.status !== "completed") {
    return jsonResponse({
      ok: true,
      ignored: true,
      status: typeof payload.status === "string" ? payload.status : null,
    });
  }

  const reference =
    typeof payload.reference_number === "string"
      ? payload.reference_number
      : null;
  const userId = parseUnlockReference(reference);
  if (!userId || !reference) {
    // A completed payment that is not a top-up (e.g. another product).
    return jsonResponse({ ok: true, ignored: true, reason: "unknown_reference" });
  }

  // The signature proves provenance; still check the paid amount/currency so a
  // mis-sized request can never credit the balance.
  const expectedAmount = dependencies.expectedAmount ?? LLM_UNLOCK_PRICE_USD;
  const expectedCurrency = (
    dependencies.expectedCurrency ?? LLM_UNLOCK_CURRENCY
  ).toUpperCase();
  const paidAmount = asAmount(payload.amount);
  const paidCurrency =
    typeof payload.currency === "string" ? payload.currency.toUpperCase() : null;
  if (
    paidAmount === null ||
    Math.abs(paidAmount - expectedAmount) > AMOUNT_EPSILON ||
    paidCurrency !== expectedCurrency
  ) {
    console.warn("[hitpay-webhook] amount/currency mismatch; not crediting", {
      paidAmount,
      paidCurrency,
      expectedAmount,
      expectedCurrency,
    });
    return jsonResponse({ ok: true, ignored: true, reason: "amount_mismatch" });
  }

  if (!dependencies.fulfil) {
    return errorResponse(
      503,
      "CONFIG_ERROR",
      "Fulfilment is not configured.",
    );
  }

  try {
    const result = await dependencies.fulfil({
      userId,
      reference,
      amount: expectedAmount,
      currency: expectedCurrency,
    });
    return jsonResponse({ ok: true, credited: result.credited, balance: result.balance });
  } catch (error) {
    console.error(
      "[hitpay-webhook] failed to record credit:",
      error instanceof Error ? error.message : error,
    );
    return errorResponse(500, "UPSTREAM_ERROR", "Could not record the payment.");
  }
}

/** Production route: verifies with `HITPAY_SALT`, credits into D1. */
export const POST: APIRoute = async (context) => {
  return handleHitPayWebhook(context, {
    salt: env.HITPAY_SALT,
    expectedAmount: LLM_UNLOCK_PRICE_USD,
    // Mirror the checkout's currency source so the amount check can never
    // disagree with what was actually charged.
    expectedCurrency: env.HITPAY_CURRENCY ?? LLM_UNLOCK_CURRENCY,
    fulfil: async ({ userId, reference, amount }) => {
      const result = await addCredit(env.DB, userId, { amount, reference });
      // Best-effort: reflect the fulfilment on the pending payment row if one
      // exists (the webhook may fire before or after the checkout write).
      try {
        const payment = await getPaymentByReference(env.DB, reference);
        if (payment) {
          await markPaymentStatus(
            env.DB,
            payment.id,
            "completed",
            new Date().toISOString(),
          );
        }
      } catch (error) {
        console.warn(
          "[hitpay-webhook] could not update payment row:",
          error instanceof Error ? error.message : error,
        );
      }
      return result;
    },
  });
};
