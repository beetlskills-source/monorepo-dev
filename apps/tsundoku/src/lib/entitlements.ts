/**
 * Centralised three-tier entitlement model. Every UI gate and AI-backed API
 * route resolves the caller through this module so the rules can never drift:
 *
 *   1. `free-unregistered` — anonymous. Stateless (local/client state only, no
 *      D1 reads or writes). Barcode scan + manual title/author search only.
 *   2. `free-registered` — signed in, no `$0.99` unlock. D1-backed shelf/group
 *      features. No AI features (no LLM summaries, no vision cover reading).
 *   3. `paid-registered` — signed in with the one-time `$0.99` LLM unlock.
 *      Everything in `free-registered` plus both AI features.
 */

import { errorResponse } from "./http";

export type UserTier =
  | "free-unregistered"
  | "free-registered"
  | "paid-registered";

/** One-time price (USD) of the AI unlock, kept in one place for UI/API copy. */
export const LLM_UNLOCK_PRICE_USD = 0.99;

/**
 * Currency the one-time unlock is charged in — sent verbatim as HitPay's
 * `currency`. Kept beside the price so the checkout, the webhook amount check,
 * and the UI copy can never drift.
 */
export const LLM_UNLOCK_CURRENCY = "USD";

export interface TierInput {
  /** The authenticated user's id, or `null`/`undefined` when anonymous. */
  userId: string | null | undefined;
  /** Whether the user holds the one-time `$0.99` LLM unlock. */
  hasLlmUnlock: boolean;
}

/** Resolve which of the three tiers the caller belongs to. */
export function resolveUserTier(input: TierInput): UserTier {
  if (!input.userId) return "free-unregistered";
  return input.hasLlmUnlock ? "paid-registered" : "free-registered";
}

/** Whether a tier may call the AI features (LLM summaries / vision cover). */
export function canUseAi(tier: UserTier): boolean {
  return tier === "paid-registered";
}

/**
 * Gate an AI-backed endpoint. Returns `null` when the caller may proceed, or a
 * `401` (anonymous) / `403` (signed in without the unlock) JSON response. Call
 * this *before* touching Featherless so free tiers never reach the LLM.
 */
export function enforceAiAccess(input: TierInput): Response | null {
  const tier = resolveUserTier(input);
  if (tier === "free-unregistered") {
    return errorResponse(
      401,
      "UNAUTHENTICATED",
      `Sign in and unlock AI features for $${LLM_UNLOCK_PRICE_USD} to use this.`,
    );
  }
  if (tier === "free-registered") {
    return errorResponse(
      403,
      "LLM_LOCKED",
      `Unlock AI features for $${LLM_UNLOCK_PRICE_USD} to use this.`,
    );
  }
  return null;
}
