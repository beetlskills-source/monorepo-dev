/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

/**
 * Server-only bindings exposed on `env` (imported from `cloudflare:workers`).
 * Secrets must never reach the client bundle. Optional bindings degrade
 * gracefully: a missing OAuth credential disables that provider and a missing
 * Resend key skips outbound email instead of failing the request.
 */
declare namespace Cloudflare {
  interface Env {
    /** D1 database holding the Better Auth tables. */
    DB: D1Database;
    /** Signing secret for Better Auth sessions/tokens (required in production). */
    BETTER_AUTH_SECRET?: string;
    /** Public origin used to build OAuth callbacks and email links. */
    BETTER_AUTH_URL?: string;
    /** `From` header for transactional email, e.g. `Tsundoku <no-reply@example.com>`. */
    AUTH_EMAIL_FROM?: string;

    FEATHERLESS_API_KEY?: string;
    /** Text model for LLM book-summary enrichment (Paid-Registered tier). */
    FEATHERLESS_MODEL?: string;
    /**
     * Multimodal model for the vision "Read Book Title" cover endpoint
     * (`/api/books/extract-cover`, Paid-Registered tier). Defaults to
     * `Qwen/Qwen2.5-VL-7B-Instruct` when unset.
     */
    FEATHERLESS_VISION_MODEL?: string;
    GOOGLE_BOOKS_API_KEY?: string;

    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    /**
     * Secret used to AES-GCM encrypt per-user Google refresh tokens before
     * they are stored in D1. Required only for the Google Sheet connect flow.
     */
    SHEET_TOKEN_ENCRYPTION_KEY?: string;
    /**
     * Public Google Picker API key. Unlike the OAuth secret it is *meant* to be
     * embedded in the browser bundle, so it is rendered into `/settings` and
     * read by the client. Restrict it to this site's HTTP referrers in the
     * Google Cloud console rather than treating it as a secret.
     */
    GOOGLE_PICKER_API_KEY?: string;
    /**
     * Google Cloud project number, passed to the Picker as `setAppId`. Public
     * and optional: the Picker still works without it on most accounts.
     */
    GOOGLE_CLOUD_PROJECT_NUMBER?: string;
    MICROSOFT_CLIENT_ID?: string;
    MICROSOFT_CLIENT_SECRET?: string;
    /** Azure AD tenant identifier; defaults to `common` (multi-tenant). */
    MICROSOFT_TENANT_ID?: string;
    MICROSOFT_TENANT_SECRET?: string;

    RESEND_API_KEY?: string;
    TURNSTILE_SECRET_KEY?: string;

    /**
     * HitPay business API key, sent as `X-BUSINESS-API-KEY` when creating the
     * one-time `$0.99` AI-unlock payment request. When unset, `/api/shelves/
     * checkout` reports a config error instead of charging.
     */
    HITPAY_API_KEY?: string;
    /** HitPay salt used to verify the `Hitpay-Signature` webhook HMAC. */
    HITPAY_SALT?: string;
    /**
     * HitPay versioned API base URL — `https://api.sandbox.hit-pay.com/v1` in
     * sandbox, `https://api.hit-pay.com/v1` in production.
     */
    HITPAY_API_URL?: string;
    /**
     * Optional currency override for the unlock charge. Defaults to
     * `LLM_UNLOCK_CURRENCY` (USD) so pricing stays in one place.
     */
    HITPAY_CURRENCY?: string;

    /**
     * Per-action USD credit rates deducted from a user's balance when an AI
     * feature runs. Each falls back to a documented default (`src/lib/credits.ts`)
     * when unset or invalid, so an unconfigured deployment still meters.
     *   - `CREDIT_RATE_BOOK_SUMMARY` (default `0.00001`) — per single book summary
     *   - `CREDIT_RATE_BATCH_BOOK_SUMMARY` (default `0.00010`) — per book in a batch run
     *   - `CREDIT_RATE_BOOK_TITLE_IMAGE` (default `0.00005`) — per cover/title image read
     */
    CREDIT_RATE_BOOK_SUMMARY?: string;
    CREDIT_RATE_BATCH_BOOK_SUMMARY?: string;
    CREDIT_RATE_BOOK_TITLE_IMAGE?: string;

    /**
     * Optional KV cache for shared-shelf reads on the dashboard. When bound,
     * another user's shared shelf is cached briefly to avoid re-reading Google
     * on every page load; when unbound, shared shelves are fetched live and the
     * dashboard still works (a safe no-KV fallback).
     */
    SHELF_CACHE?: KVNamespace;
  }
}

/**
 * Per-request SSR context. `user` / `session` are resolved by `src/middleware.ts`
 * and are `null` for anonymous visitors and on any route that skips middleware.
 */
declare namespace App {
  interface Locals {
    user: import("better-auth").User | null;
    session: import("better-auth").Session | null;
  }
}
