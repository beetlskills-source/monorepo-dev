import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { jsonResponse } from "../../../lib/http";
import {
  readShelfEntitlement,
  type ShelfEntitlement,
} from "../../../lib/llm-entitlement";

export const prerender = false;

/**
 * Overridable configuration for the entitlement-status handler. The entitlement
 * reader is injectable so tests never touch D1.
 */
export interface EntitlementDependencies {
  /** The authenticated user's id, or `null`/`undefined` when anonymous. */
  userId?: string | null;
  /** Single-source entitlement reader (defaults to a locked result). */
  readEntitlement?: (userId: string) => Promise<ShelfEntitlement>;
}

/**
 * Read-only `GET /api/shelves/entitlement`. The scanner polls this after HitPay
 * redirects the shopper back so the UI flips to unlocked even when the webhook
 * lands a moment after the browser redirect. Anonymous callers always get a
 * locked, `signedIn: false` payload (200) so the client can poll uniformly.
 */
export async function handleEntitlement(
  dependencies: EntitlementDependencies = {},
): Promise<Response> {
  const userId = dependencies.userId;
  if (!userId) {
    return jsonResponse({
      signedIn: false,
      hasLlmUnlock: false,
      enrichWithLlm: false,
      creditBalance: 0,
    });
  }

  const entitlement = dependencies.readEntitlement
    ? await dependencies.readEntitlement(userId)
    : { hasLlmUnlock: false, enrichWithLlm: false, creditBalance: 0 };

  return jsonResponse({ signedIn: true, ...entitlement });
}

/** Production route: reads the caller's entitlement through the shared helper. */
export const GET: APIRoute = async (context) => {
  const user = context.locals.user;
  return handleEntitlement({
    userId: user?.id ?? null,
    readEntitlement: (userId) => readShelfEntitlement(env.DB, userId),
  });
};
