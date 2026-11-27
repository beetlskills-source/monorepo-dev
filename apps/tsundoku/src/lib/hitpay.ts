/**
 * HitPay Payments API client + webhook signature verification.
 *
 * Kept free of Astro/Worker APIs so the request shape and the HMAC check are
 * deterministic and unit-testable. The caller supplies the base URL (from
 * `HITPAY_API_URL`), the business API key (from `HITPAY_API_KEY`), and — for
 * webhooks — the salt (from `HITPAY_SALT`). Secrets are never logged.
 *
 * Docs: POST `{baseUrl}/payment-requests` with `X-BUSINESS-API-KEY`; HitPay
 * posts payment webhooks signed with HMAC-SHA256 of the raw JSON body using the
 * dashboard salt, carried in the `Hitpay-Signature` header.
 */

/** Path (relative to the versioned base URL) that creates a payment request. */
export const HITPAY_PAYMENT_REQUESTS_PATH = "/payment-requests";

/** Header HitPay uses for the HMAC-SHA256 webhook signature. */
export const HITPAY_SIGNATURE_HEADER = "hitpay-signature";

/** Abort a hung HitPay call after this many milliseconds. */
export const HITPAY_TIMEOUT_MS = 15_000;

/** Raised when HitPay is unreachable or returns an unusable response. */
export class HitPayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HitPayError";
  }
}

export interface HitPayClientOptions {
  /** Business API key (`HITPAY_API_KEY`), sent as `X-BUSINESS-API-KEY`. */
  apiKey: string;
  /** Versioned base URL, e.g. `https://api.hit-pay.com/v1`. */
  baseUrl: string;
  /** Injectable fetch implementation, mainly for tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface CreatePaymentRequestInput {
  /** Amount in the currency's major unit (e.g. `0.99` for US$0.99). */
  amount: number;
  /** ISO currency code, e.g. `USD`. */
  currency: string;
  /** Opaque reference echoed back on the webhook (here: the unlock reference). */
  referenceNumber: string;
  /** URL the customer is sent to after paying. */
  redirectUrl: string;
  /**
   * Per-request webhook URL. HitPay documents this field as deprecated in favour
   * of dashboard-registered webhook endpoints; it is still sent for
   * compatibility but fulfilment must not rely on it.
   */
  webhookUrl?: string;
  email?: string | null;
  name?: string | null;
  purpose?: string | null;
  /** Optional allow-list of methods; omitted lets the account defaults apply. */
  paymentMethods?: string[];
}

export interface HitPayPaymentRequest {
  id: string;
  /** Hosted checkout URL to redirect the customer to. */
  url: string;
  status: string;
  referenceNumber: string | null;
}

/** A payment request's live state, read back from HitPay for reconciliation. */
export interface HitPayPaymentRequestDetails {
  id: string;
  /** `pending` | `completed` | `failed` | `expired` | `canceled` | `inactive`. */
  status: string;
  /** Paid amount in the currency's major unit (e.g. `0.99`), or `null`. */
  amount: number | null;
  currency: string | null;
  referenceNumber: string | null;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** HMAC-SHA256 of `message` keyed by `secret`, as lowercase hex. */
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return toHex(new Uint8Array(signature));
}

/** Length-independent, constant-time comparison of two hex digests. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verify a HitPay webhook against `HITPAY_SALT`. Returns `false` (never throws)
 * for a missing salt/signature, a malformed value, or a mac that does not match
 * the HMAC-SHA256 of the exact raw request body.
 */
export async function verifyHitPaySignature(
  salt: string | undefined,
  rawBody: string,
  signature: string | null | undefined,
): Promise<boolean> {
  if (!salt || typeof signature !== "string" || signature.trim() === "") {
    return false;
  }
  const expected = await hmacSha256Hex(salt, rawBody);
  return timingSafeEqualHex(expected, signature.trim().toLowerCase());
}

/**
 * Create a HitPay payment request and return its hosted checkout `url`. Throws
 * a {@link HitPayError} on a network failure or a non-2xx / unusable response.
 */
export async function createHitPayPaymentRequest(
  config: HitPayClientOptions,
  input: CreatePaymentRequestInput,
): Promise<HitPayPaymentRequest> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const endpoint = `${trimTrailingSlash(config.baseUrl)}${HITPAY_PAYMENT_REQUESTS_PATH}`;

  const body: Record<string, unknown> = {
    amount: input.amount,
    currency: input.currency,
    reference_number: input.referenceNumber,
    redirect_url: input.redirectUrl,
  };
  if (input.webhookUrl) body.webhook = input.webhookUrl;
  if (input.email) body.email = input.email;
  if (input.name) body.name = input.name;
  if (input.purpose) body.purpose = input.purpose;
  if (input.paymentMethods && input.paymentMethods.length > 0) {
    body.payment_methods = input.paymentMethods;
  }

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "X-BUSINESS-API-KEY": config.apiKey,
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs ?? HITPAY_TIMEOUT_MS),
    });
  } catch (error) {
    throw new HitPayError(
      `Could not reach HitPay: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  const record =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;

  if (!response.ok) {
    const message =
      typeof record?.message === "string"
        ? record.message
        : typeof record?.error === "string"
          ? record.error
          : `HTTP ${response.status}`;
    throw new HitPayError(`HitPay rejected the payment request: ${message}`);
  }

  const id = typeof record?.id === "string" ? record.id : null;
  const checkoutUrl = typeof record?.url === "string" ? record.url : null;
  if (!id || !checkoutUrl) {
    throw new HitPayError("HitPay response did not include a checkout url.");
  }

  return {
    id,
    url: checkoutUrl,
    status: typeof record?.status === "string" ? record.status : "pending",
    referenceNumber:
      typeof record?.reference_number === "string"
        ? record.reference_number
        : null,
  };
}

/** Coerce a HitPay amount (string major unit or number) into a number. */
function toMajorUnit(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Fetch a payment request's current state from HitPay
 * (`GET {baseUrl}/payment-requests/{requestId}`). Used by the return-time
 * reconcile to confirm a payment even when the deprecated per-request webhook
 * is never delivered. Throws a {@link HitPayError} on a network failure or a
 * non-2xx / unusable response.
 */
export async function getHitPayPaymentRequest(
  config: HitPayClientOptions,
  requestId: string,
): Promise<HitPayPaymentRequestDetails> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const endpoint = `${trimTrailingSlash(config.baseUrl)}${HITPAY_PAYMENT_REQUESTS_PATH}/${encodeURIComponent(requestId)}`;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "GET",
      headers: {
        "X-BUSINESS-API-KEY": config.apiKey,
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      signal: AbortSignal.timeout(config.timeoutMs ?? HITPAY_TIMEOUT_MS),
    });
  } catch (error) {
    throw new HitPayError(
      `Could not reach HitPay: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  const record =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;

  if (!response.ok) {
    const message =
      typeof record?.message === "string"
        ? record.message
        : typeof record?.error === "string"
          ? record.error
          : `HTTP ${response.status}`;
    throw new HitPayError(`HitPay rejected the payment lookup: ${message}`);
  }

  if (!record || typeof record.id !== "string") {
    throw new HitPayError("HitPay response did not include a payment request id.");
  }

  return {
    id: record.id,
    status: typeof record.status === "string" ? record.status : "pending",
    amount: toMajorUnit(record.amount),
    currency: typeof record.currency === "string" ? record.currency : null,
    referenceNumber:
      typeof record.reference_number === "string"
        ? record.reference_number
        : null,
  };
}
