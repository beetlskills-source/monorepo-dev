/**
 * Single source of truth for the credit-funded AI entitlement.
 *
 * AI access is no longer a one-time boolean unlock: a `$0.99` HitPay top-up adds
 * USD credit and every AI action deducts its configured rate, so "unlocked"
 * simply means *a positive remaining credit balance*. The balance is always
 * derived from the append-only `credit_ledger` (see `src/lib/credits.ts`), so the
 * scanner page's server render, the `/api/shelves/*` AI routes, the entitlement
 * status endpoint, and the HitPay fulfilment can never disagree about a user's
 * tier.
 *
 * Reads fail *closed*: a missing ledger row, an unapplied migration, or any D1
 * error resolves to "locked" so a free tier can never reach the paid AI features
 * by accident.
 */

import { getCreditBalance } from "./credits";
import { getShelfConfig } from "./shelf-configs";

/**
 * Prefix for the HitPay `reference_number` that ties a top-up payment back to
 * the paying user. The raw user id follows the prefix (optionally with a
 * per-payment nonce suffix); a webhook only fulfils a payment whose reference
 * carries the prefix.
 */
export const LLM_UNLOCK_REFERENCE_PREFIX = "llmunlock:";

/**
 * Build the `reference_number` sent with a top-up checkout. A `nonce` makes each
 * payment request's reference unique (HitPay requires a distinct reference), and
 * the ledger's unique index uses the same value as the idempotency key.
 */
export function buildUnlockReference(userId: string, nonce?: string): string {
  const base = `${LLM_UNLOCK_REFERENCE_PREFIX}${userId}`;
  return nonce ? `${base}:${nonce}` : base;
}

/**
 * Extract the user id from a top-up `reference_number`, or `null` when the
 * value is missing, empty, or belongs to a different payment type. Matches
 * both `llmunlock:<userId>` and `llmunlock:<userId>:<nonce>`.
 */
export function parseUnlockReference(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string" || !value.startsWith(LLM_UNLOCK_REFERENCE_PREFIX)) {
    return null;
  }
  const rest = value.slice(LLM_UNLOCK_REFERENCE_PREFIX.length);
  // The user id is the first segment; a per-payment nonce may follow.
  const userId = rest.split(":")[0]?.trim() ?? "";
  return userId === "" ? null : userId;
}

/** The entitlement facts the scanner and AI routes care about, resolved together. */
export interface ShelfEntitlement {
  /**
   * Whether the user may use the AI features — i.e. they hold a positive credit
   * balance. (Named for historical continuity; it is now credit-derived.)
   */
  hasLlmUnlock: boolean;
  /** Whether the user wants per-scan LLM enrichment (a preference, not a grant). */
  enrichWithLlm: boolean;
  /** The user's current remaining USD credit balance. */
  creditBalance: number;
}

/**
 * Read a signed-in user's entitlement in a single round-trip. On any failure
 * (no row, unapplied migration, D1 error) it resolves to the locked defaults so
 * the caller degrades to the free tier instead of erroring.
 */
export async function readShelfEntitlement(
  db: D1Database,
  userId: string,
): Promise<ShelfEntitlement> {
  try {
    const [config, balance] = await Promise.all([
      getShelfConfig(db, userId),
      getCreditBalance(db, userId),
    ]);
    return {
      hasLlmUnlock: balance > 0,
      enrichWithLlm: config?.enrichWithLlm ?? false,
      creditBalance: balance,
    };
  } catch (error) {
    // Fail closed, but log first: silently returning "locked" for a schema
    // drift (e.g. an unapplied `credit_ledger` migration) makes a deployment
    // bug look like a legitimate free-tier user and hides the real cause.
    console.warn(
      "[llm-entitlement] entitlement read failed; defaulting to locked:",
      error instanceof Error ? error.message : error,
    );
    return { hasLlmUnlock: false, enrichWithLlm: false, creditBalance: 0 };
  }
}

/** Convenience wrapper: whether the user has AI access (credit > 0), failing closed. */
export async function isLlmUnlocked(
  db: D1Database,
  userId: string,
): Promise<boolean> {
  return (await readShelfEntitlement(db, userId)).hasLlmUnlock;
}
