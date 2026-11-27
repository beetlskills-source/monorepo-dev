import type { APIContext, APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  LLM_UNLOCK_CURRENCY,
  LLM_UNLOCK_PRICE_USD,
} from "../../../lib/entitlements";
import {
  type RecordPaymentInput,
  recordPendingPayment,
} from "../../../lib/credits";
import {
  createHitPayPaymentRequest,
  HitPayError,
  type HitPayPaymentRequest,
} from "../../../lib/hitpay";
import { errorResponse, jsonResponse } from "../../../lib/http";
import { buildUnlockReference } from "../../../lib/llm-entitlement";

export const prerender = false;

/**
 * Query parameter HitPay appends to the return URL so the scanner can start
 * polling for the fulfilled entitlement while the webhook lands.
 */
export const CHECKOUT_RETURN_PARAM = "unlock";
export const CHECKOUT_RETURN_VALUE = "return";
/**
 * Return-URL parameter carrying this payment's `reference_number`, so the
 * return-time reconcile can look the payment up and credit it even when the
 * deprecated per-request webhook is never delivered.
 */
export const CHECKOUT_RETURN_REFERENCE_PARAM = "ref";

/** Path HitPay calls (server-to-server) to confirm a completed payment. */
export const HITPAY_WEBHOOK_PATH = "/api/webhooks/hitpay";

/** Purpose string shown on the HitPay checkout page. */
const CHECKOUT_PURPOSE = "Tsundoku — AI credit top-up";

/**
 * Overridable server-side configuration for the checkout handler. Every
 * secret, the app origin, the entitlement lookup, the payment persistence, and
 * the HitPay call are injectable so tests never touch the live network,
 * secrets, or D1.
 */
export interface CheckoutDependencies {
  /** The authenticated user's id, or `null`/`undefined` for anonymous callers. */
  userId?: string | null;
  email?: string | null;
  name?: string | null;
  /** HitPay business API key (`HITPAY_API_KEY`). */
  hitpayApiKey?: string;
  /** HitPay versioned base URL (`HITPAY_API_URL`). */
  hitpayApiUrl?: string;
  /** Public app origin used to build the return + webhook URLs. */
  appOrigin?: string;
  /** Charge currency; defaults to {@link LLM_UNLOCK_CURRENCY}. */
  currency?: string;
  /** Charge amount; defaults to {@link LLM_UNLOCK_PRICE_USD}. */
  amount?: number;
  /**
   * Same-origin relative path HitPay redirects the shopper back to after
   * payment (e.g. `/settings`). Sanitised to a bare path so the return URL can
   * never leave this origin; defaults to `/`.
   */
  returnPath?: string;
  /** Injectable payment-request creator (defaults to the real HitPay client). */
  createPaymentRequest?: (
    config: { apiKey: string; baseUrl: string; fetchImpl?: typeof fetch },
    input: Parameters<typeof createHitPayPaymentRequest>[1],
  ) => Promise<HitPayPaymentRequest>;
  /** Persist the pending payment so a return can reconcile it. */
  recordPayment?: (input: RecordPaymentInput) => Promise<void>;
  /** Injectable nonce source (defaults to a random UUID) for unique references. */
  nonce?: string;
  fetchImpl?: typeof fetch;
}

function normalizeOrigin(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Only a same-origin relative path may be used as the return target, so a
 * crafted `returnTo` can never redirect the shopper (or the carried reference)
 * to another origin. Query/hash are dropped; the checkout params are appended
 * by this handler.
 */
function sanitizeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  const [path] = value.split(/[?#]/);
  return path && path.startsWith("/") ? path : "/";
}

/**
 * Testable `POST /api/shelves/checkout` handler. Signed-in users only: it
 * creates a HitPay payment request for the `$0.99` AI credit top-up, tags it
 * with the caller's user id (reference + metadata), persists a pending payment
 * row, and returns the hosted checkout `url`. Top-ups are **repeatable**: a
 * caller who already holds credit is charged again (the UI keeps the
 * "Top up AI credits" button available at any balance).
 */
export async function handleCheckout(
  context: Pick<APIContext, "request">,
  dependencies: CheckoutDependencies = {},
): Promise<Response> {
  const userId = dependencies.userId;
  if (!userId) {
    return errorResponse(
      401,
      "UNAUTHENTICATED",
      "Sign in to add AI credit.",
    );
  }

  if (!dependencies.hitpayApiKey || !dependencies.hitpayApiUrl) {
    return errorResponse(
      503,
      "CONFIG_ERROR",
      "Checkout is not configured on this deployment.",
    );
  }

  const origin = normalizeOrigin(
    dependencies.appOrigin ?? new URL(context.request.url).origin,
  );
  const returnPath = sanitizeReturnPath(dependencies.returnPath);
  const currency = dependencies.currency ?? LLM_UNLOCK_CURRENCY;
  const amount = dependencies.amount ?? LLM_UNLOCK_PRICE_USD;
  // A unique reference per payment is both HitPay's requirement and the credit
  // ledger's idempotency key, so a replayed webhook/reconcile never double-credits.
  const referenceNumber = buildUnlockReference(
    userId,
    dependencies.nonce ?? crypto.randomUUID(),
  );

  const create = dependencies.createPaymentRequest ?? createHitPayPaymentRequest;
  const record = dependencies.recordPayment ?? ((input) =>
    recordPendingPayment(env.DB, input));

  try {
    const payment = await create(
      {
        apiKey: dependencies.hitpayApiKey,
        baseUrl: dependencies.hitpayApiUrl,
        fetchImpl: dependencies.fetchImpl,
      },
      {
        amount,
        currency,
        referenceNumber,
        redirectUrl: `${origin}${returnPath}?${CHECKOUT_RETURN_PARAM}=${CHECKOUT_RETURN_VALUE}&${CHECKOUT_RETURN_REFERENCE_PARAM}=${encodeURIComponent(referenceNumber)}`,
        // HitPay documents the per-request `webhook` field as deprecated in
        // favour of dashboard-registered endpoints; sent for compatibility but
        // fulfilment does not depend on it (the return URL reconciles instead).
        webhookUrl: `${origin}${HITPAY_WEBHOOK_PATH}`,
        email: dependencies.email ?? null,
        name: dependencies.name ?? null,
        purpose: CHECKOUT_PURPOSE,
      },
    );

    // Best-effort: persist the pending payment so the return-time reconcile can
    // confirm it via HitPay's status API. A failure here must not block checkout
    // — the webhook path can still credit the payment.
    try {
      await record({
        id: payment.id,
        userId,
        reference: referenceNumber,
        amount,
        currency,
      });
    } catch (error) {
      console.warn(
        "[checkout] could not persist pending payment:",
        error instanceof Error ? error.message : error,
      );
    }

    return jsonResponse({
      ok: true,
      url: payment.url,
      referenceNumber: payment.referenceNumber ?? referenceNumber,
      currency,
      amount,
    });
  } catch (error) {
    console.warn(
      "[checkout] HitPay payment request failed:",
      error instanceof Error ? error.message : error,
    );
    return errorResponse(
      502,
      "UPSTREAM_ERROR",
      error instanceof HitPayError
        ? "Could not start HitPay checkout. Please try again shortly."
        : "Could not start checkout. Please try again shortly.",
    );
  }
}

/** Production route: requires a session and wires the real `env` + D1. */
export const POST: APIRoute = async (context) => {
  const user = context.locals.user;
  // The scanner returns to "/" and the settings page to "/settings"; the
  // optional `returnTo` body field selects the target (sanitised downstream).
  let returnPath: string | undefined;
  try {
    const body = (await context.request.json()) as { returnTo?: unknown } | null;
    if (body && typeof body.returnTo === "string") returnPath = body.returnTo;
  } catch {
    // No JSON body — fall back to the default "/" return target.
  }
  return handleCheckout(context, {
    userId: user?.id ?? null,
    email: user?.email ?? null,
    name: user?.name ?? null,
    hitpayApiKey: env.HITPAY_API_KEY,
    hitpayApiUrl: env.HITPAY_API_URL,
    appOrigin: env.BETTER_AUTH_URL,
    currency: env.HITPAY_CURRENCY,
    returnPath,
    recordPayment: (input) => recordPendingPayment(env.DB, input),
  });
};
