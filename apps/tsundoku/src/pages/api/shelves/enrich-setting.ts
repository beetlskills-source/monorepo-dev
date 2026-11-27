import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { enforceAiAccess } from "../../../lib/entitlements";
import { errorResponse, jsonResponse } from "../../../lib/http";
import { EnrichSettingRequestSchema } from "../../../lib/sheet-flow";
import { isLlmUnlocked } from "../../../lib/llm-entitlement";
import { upsertShelfConfig } from "../../../lib/shelf-configs";

export const prerender = false;

/**
 * Persist the ISBN Scanner's "Enrich book info with LLM" preference on the
 * user's `shelf_configs` row. The scanner reads this back on load (and the
 * lookup route consults it), so toggling here takes effect on the next scan
 * without a full page reload. Creating a row via upsert means the preference
 * survives even before a Google Sheet is connected.
 */
export const POST: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(
      401,
      "UNAUTHENTICATED",
      "Sign in to change enrichment settings.",
    );
  }

  // The enrichment preference only controls a Paid-Registered AI feature, so
  // it is gated on the $0.99 LLM unlock (single-source read, failing closed).
  const hasLlmUnlock = await isLlmUnlocked(env.DB, user.id);
  const denied = enforceAiAccess({ userId: user.id, hasLlmUnlock });
  if (denied) return denied;

  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }

  const parsed = EnrichSettingRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "Provide enrichWithLlm (boolean).",
    );
  }

  const config = await upsertShelfConfig(env.DB, user.id, {
    enrichWithLlm: parsed.data.enrichWithLlm,
  });

  return jsonResponse({ ok: true, enrichWithLlm: config.enrichWithLlm });
};
