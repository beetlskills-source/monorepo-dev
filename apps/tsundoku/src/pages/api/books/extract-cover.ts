import type { APIContext, APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  CoverExtractRequestSchema,
  CoverLookupResponseSchema,
  type CatalogBook,
  type CatalogEdition,
  type CatalogSource,
  type CoverExtraction,
  type CoverLookupResponse,
} from "@repo/book-schemas";
import { toIsbn13 } from "@repo/isbn";
import { createCatalogClient, type CatalogClient } from "../../../lib/catalog";
import {
  CREDIT_ACTION_BOOK_SUMMARY,
  CREDIT_ACTION_BOOK_TITLE_IMAGE,
  rateForAction,
  recordUsage,
  resolveCreditRates,
} from "../../../lib/credits";
import { enforceAiAccess } from "../../../lib/entitlements";
import {
  createFeatherlessClient,
  DEFAULT_FEATHERLESS_VISION_MODEL,
} from "../../../lib/featherless";
import { errorResponse, jsonResponse } from "../../../lib/http";
import { readShelfEntitlement } from "../../../lib/llm-entitlement";

export const prerender = false;

/** Maximum decoded cover-image size accepted from the client (1 MB). */
export const MAX_COVER_IMAGE_BYTES = 1_000_000;

/** Image MIME types the client is expected to send (already JPEG-compressed). */
const ALLOWED_IMAGE_MIME = ["image/jpeg", "image/webp"];

/**
 * Decode an `data:<mime>;base64,<payload>` URL into its MIME type and decoded
 * byte length, without materialising the bytes. Returns `null` for anything
 * that is not a base64 image data URL, so a non-image or raw base64 payload is
 * rejected before a byte is counted.
 */
export function parseCoverDataUrl(
  value: string,
): { mime: string; bytes: number } | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(value.trim());
  if (!match) return null;
  const mime = (match[1] ?? "").toLowerCase();
  const base64 = match[2] ?? "";
  // Each 4 base64 chars decode to 3 bytes; trailing `=` padding is not data.
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((base64.length * 3) / 4) - padding;
  return { mime, bytes };
}

/**
 * Overridable server-side configuration for the cover-vision handler. The
 * entitlement flags, key, and `fetchImpl` are injectable so tests never touch
 * the live network, secrets, or D1.
 */
export interface ExtractCoverDependencies {
  /** The authenticated user's id, or `null`/`undefined` for anonymous callers. */
  userId?: string | null;
  /** Whether the caller holds the one-time `$0.99` LLM unlock. */
  hasLlmUnlock?: boolean;
  /** Featherless API key; when absent the endpoint reports a config error. */
  apiKey?: string;
  /** Vision model override; defaults to `DEFAULT_FEATHERLESS_VISION_MODEL`. */
  model?: string;
  /** Text model override for the enrichment step; defaults inside the client. */
  summaryModel?: string;
  /**
   * Whether the caller opted into LLM enrichment ("Enrich book info with LLM").
   * Runs only against a resolved catalog match with a valid ISBN, and degrades
   * gracefully — a failure still returns the catalog result (`enriched: false`).
   */
  enrich?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  temperature?: number;
  /**
   * Catalog client used to promote the vision hints to canonical metadata.
   * When omitted (or when it throws) the handler degrades to `vision_only` and
   * returns the grounded vision hints unchanged, so a catalog outage never
   * fails a cover read. Tests inject a stub; production wires the real client.
   */
  catalog?: CatalogClient;
  /**
   * Meter one cover/title image read against the user's credit balance. Invoked
   * best-effort after a successful extraction; a metering failure never fails
   * the user's request.
   */
  chargeUsage?: (units: number) => Promise<unknown>;
  /**
   * Meter one LLM summary against the user's credit balance when the optional
   * enrichment step produces a summary. Best-effort, like {@link chargeUsage}.
   */
  chargeSummary?: (units: number) => Promise<unknown>;
}

/** Canonical catalog fields distilled from an ISBN lookup or a title search. */
interface CatalogMatch {
  title: string;
  authors: string[];
  publisher: string | null;
  publishedYear: number | null;
  isbn: string | null;
  source: CatalogSource;
}

/** The resolved catalog match plus the candidate editions behind it. */
interface CatalogLookup {
  match: CatalogMatch | null;
  /** Candidate editions surfaced for the "Possible Book Titles" list. */
  candidates: CatalogEdition[];
}

/** Distil an edition down to the canonical match fields. */
function editionToMatch(edition: CatalogEdition): CatalogMatch {
  return {
    title: edition.title,
    authors: edition.authors,
    publisher: edition.publisher,
    publishedYear: edition.publishedYear,
    isbn: edition.isbn13 ?? edition.isbn10 ?? null,
    source: edition.source,
  };
}

/**
 * Project an ISBN lookup result (`CatalogBook`, which always carries an
 * ISBN-13 and no ISBN-10) into the edition shape the candidate list uses.
 */
function bookToEdition(book: CatalogBook): CatalogEdition {
  return {
    title: book.title,
    authors: book.authors,
    publisher: book.publisher,
    publishedYear: book.publishedYear,
    isbn13: book.isbn13,
    isbn10: null,
    source: book.source,
  };
}

/**
 * Turn the model's free-form `isbn` hint into a canonical ISBN-13, or `null`
 * when it is not a valid ISBN-10/13 (rejecting hallucinated or partial digits).
 */
function resolveIsbnHint(isbn: string | null): string | null {
  if (!isbn) return null;
  return toIsbn13(isbn);
}

/**
 * Strip a leading/trailing author attribution from a vision title hint so a
 * cover read like `"Chris Guillebeau's The $100 Startup"` is reduced to the
 * clean title `"The $100 Startup"` that a catalog search can actually match.
 * Only removes an attribution that names one of the already-extracted authors,
 * so an ordinary title is never mangled.
 */
export function stripAuthorAttribution(
  title: string,
  authors: readonly string[],
): string {
  let result = title.trim();
  for (const author of authors) {
    const name = author.trim();
    if (name === "") continue;
    const lower = result.toLowerCase();
    const nameLower = name.toLowerCase();

    // Leading possessive / attribution: `Author's Title`, `Author - Title`.
    for (const separator of ["'s ", "\u2019s ", " - ", ": "]) {
      const prefix = `${nameLower}${separator}`;
      if (lower.startsWith(prefix)) {
        result = result.slice(prefix.length).trim();
        break;
      }
    }

    // Trailing attribution: `Title by Author`.
    const suffix = ` by ${nameLower}`;
    if (result.toLowerCase().endsWith(suffix)) {
      result = result.slice(0, result.length - suffix.length).trim();
    }
  }
  return result;
}

/**
 * Query the catalog with the vision hints as a starting point: an exact ISBN
 * lookup when the cover carried a legible one, otherwise a title (optionally
 * author-refined) edition search. The raw hint title is tried first, then a
 * cleaned variant with any author attribution removed, so a hallucinated
 * possessive prefix cannot stop a real catalog match. Returns the best match
 * (or `null`) alongside the catalogue editions that back it, which the client
 * offers as the "Possible Book Titles" disambiguation list.
 */
async function lookupCatalog(
  catalog: CatalogClient,
  hint: CoverExtraction,
): Promise<CatalogLookup> {
  const hintIsbn13 = resolveIsbnHint(hint.isbn);
  if (hintIsbn13) {
    const book = await catalog.lookupByIsbn(hintIsbn13);
    if (book) {
      const edition = bookToEdition(book);
      return { match: editionToMatch(edition), candidates: [edition] };
    }
  }

  const rawTitle = hint.title.trim();
  if (rawTitle === "") return { match: null, candidates: [] };
  const cleanedTitle = stripAuthorAttribution(rawTitle, hint.authors);
  const titleCandidates =
    cleanedTitle !== "" && cleanedTitle !== rawTitle
      ? [rawTitle, cleanedTitle]
      : [rawTitle];

  for (const title of titleCandidates) {
    const editions = await catalog.searchEditions({
      title,
      author: hint.authors[0],
    });
    const best = editions[0];
    if (best) {
      return { match: editionToMatch(best), candidates: editions };
    }
  }
  return { match: null, candidates: [] };
}

/**
 * Combine the vision hints with a catalog match. Catalog metadata wins for
 * `title`/`authors`/`publisher`/`isbn` (the vision model's job is to *find* the
 * book, not to be the record of truth); the vision hints are only kept where
 * the catalog has nothing to say — including `subtitle`, which no catalog
 * provider supplies. With no match the grounded vision hints stand alone and
 * `source` is `"vision_only"`. The optional `enrichment` (a best-effort LLM
 * summary) and the catalog `candidates` (for the client's "Possible Book
 * Titles" list) are carried through on the resolved response.
 */
function resolveCoverMetadata(
  hint: CoverExtraction,
  match: CatalogMatch | null,
  enrichment: { summary: string | null; enriched: boolean },
  candidates: CatalogEdition[],
): CoverLookupResponse {
  const hintIsbn13 = resolveIsbnHint(hint.isbn);
  if (!match) {
    return {
      title: hint.title,
      subtitle: hint.subtitle,
      authors: hint.authors,
      publisher: hint.publisher,
      publishedYear: null,
      isbn: hintIsbn13,
      summary: null,
      enriched: false,
      source: "vision_only",
      provider: null,
      confidence: "low",
      candidates,
    };
  }
  return {
    title: match.title.trim() !== "" ? match.title : hint.title,
    subtitle: hint.subtitle,
    authors: match.authors.length > 0 ? match.authors : hint.authors,
    publisher: match.publisher ?? hint.publisher,
    publishedYear: match.publishedYear,
    isbn: match.isbn ?? hintIsbn13,
    summary: enrichment.summary,
    enriched: enrichment.enriched,
    source: "catalog_lookup",
    provider: match.source,
    confidence: "high",
    candidates,
  };
}

/**
 * Run the metering callback without letting a metering failure break the user's
 * request (the AI work has already been done and paid for upstream).
 */
async function meterUsage(
  charge: ((units: number) => Promise<unknown>) | undefined,
  units = 1,
): Promise<void> {
  if (!charge) return;
  try {
    await charge(units);
  } catch (error) {
    console.warn(
      "[credits] usage metering failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Testable `POST /api/books/extract-cover` handler: a Paid-Registered-only,
 * multimodal cover reader that runs the *entire* cover pipeline in a single
 * pass. Enforces the entitlement **before** any parsing or upstream call,
 * accepts a compressed JPEG/WebP base64 data URL (≤ 1 MB), reads the cover with
 * a vision model as a *hint*, promotes `title`/`isbn` hints to canonical
 * metadata via the catalog, optionally enriches the resolved book with an LLM
 * summary (only when the caller opted in and a catalog match was found), and
 * returns the fully resolved result — so the client can render "Match found"
 * directly without a second lookup request.
 */
export async function handleExtractCover(
  context: Pick<APIContext, "request">,
  dependencies: ExtractCoverDependencies = {},
): Promise<Response> {
  // Paid-Registered only — gate first so free tiers never reach Featherless.
  const denied = enforceAiAccess({
    userId: dependencies.userId,
    hasLlmUnlock: dependencies.hasLlmUnlock ?? false,
  });
  if (denied) return denied;

  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }

  const parsed = CoverExtractRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "Provide a base64 'image' data URL.",
    );
  }

  const image = parseCoverDataUrl(parsed.data.image);
  if (!image || !ALLOWED_IMAGE_MIME.includes(image.mime)) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "The image must be a JPEG or WebP base64 data URL.",
    );
  }
  if (image.bytes > MAX_COVER_IMAGE_BYTES) {
    return errorResponse(
      413,
      "PAYLOAD_TOO_LARGE",
      `The cover image must be at most ${MAX_COVER_IMAGE_BYTES} bytes.`,
    );
  }

  if (!dependencies.apiKey) {
    return errorResponse(
      503,
      "CONFIG_ERROR",
      "Cover reading is not configured on this deployment.",
    );
  }

  const client = createFeatherlessClient({
    apiKey: dependencies.apiKey,
    model: dependencies.model ?? DEFAULT_FEATHERLESS_VISION_MODEL,
    fetchImpl: dependencies.fetchImpl,
    timeoutMs: dependencies.timeoutMs,
    temperature: dependencies.temperature,
  });

  try {
    // The vision model only supplies grounded hints (null/empty for anything it
    // cannot clearly see); `title`/`isbn` are then used to query the catalog.
    const hint = await client.extractCover(parsed.data.image);

    let lookup: CatalogLookup = { match: null, candidates: [] };
    if (dependencies.catalog) {
      try {
        lookup = await lookupCatalog(dependencies.catalog, hint);
      } catch (error) {
        // A catalog outage must never fail the read; fall back to vision-only.
        console.warn(
          "[extract-cover] catalog lookup failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }
    const match = lookup.match;

    // Optional enrichment, folded into this same pass: it runs only against a
    // resolved catalog match with a valid ISBN-13 and only when the caller
    // opted into "Enrich book info with LLM". Best-effort — a failure still
    // returns the catalog result (`enriched: false`) rather than failing the
    // whole cover read.
    let enrichment: { summary: string | null; enriched: boolean } = {
      summary: null,
      enriched: false,
    };
    const matchIsbn13 = match?.isbn ? toIsbn13(match.isbn) : null;
    if (
      match &&
      matchIsbn13 &&
      dependencies.apiKey &&
      (dependencies.enrich ?? false)
    ) {
      try {
        const enrichmentClient = createFeatherlessClient({
          apiKey: dependencies.apiKey,
          model: dependencies.summaryModel,
          fetchImpl: dependencies.fetchImpl,
          timeoutMs: dependencies.timeoutMs,
          temperature: dependencies.temperature,
        });
        const result = await enrichmentClient.enrichBook({
          isbn13: matchIsbn13,
          title: match.title,
          authors: match.authors,
          publisher: match.publisher,
          publishedYear: match.publishedYear,
          source: match.source,
          verified: true,
        });
        const summary =
          result.summary !== null && result.summary.trim() !== ""
            ? result.summary
            : null;
        enrichment = { summary, enriched: summary !== null };
        // Meter only when a summary was actually produced (best-effort).
        if (summary !== null) await meterUsage(dependencies.chargeSummary, 1);
      } catch (error) {
        console.warn(
          "[extract-cover] enrichment skipped:",
          error instanceof Error ? error.message : error,
        );
      }
    }

    const resolution = resolveCoverMetadata(
      hint,
      match,
      enrichment,
      lookup.candidates,
    );

    // Provenance log: hints vs. final fields, so a misattribution is diagnosable.
    console.log("[extract-cover] metadata resolved", {
      source: resolution.source,
      hints: { title: hint.title, isbn: hint.isbn },
      resolved: {
        title: resolution.title,
        authors: resolution.authors,
        publisher: resolution.publisher,
        isbn: resolution.isbn,
      },
    });

    // Meter the successful read before responding (best-effort).
    await meterUsage(dependencies.chargeUsage, 1);
    return jsonResponse(CoverLookupResponseSchema.parse(resolution), 200);
  } catch (error) {
    console.warn(
      "[extract-cover] vision read failed:",
      error instanceof Error ? error.message : error,
    );
    return errorResponse(
      502,
      "UPSTREAM_ERROR",
      "Could not read that cover. Try a clearer, closer photo.",
    );
  }
}

/** Production route: resolves the caller's tier, then wires the real `env`. */
export const POST: APIRoute = async (context) => {
  const user = context.locals.user;
  // Single-source entitlement read; fails closed on a D1 error or an unapplied
  // migration so a locked tier can never reach the vision model.
  let hasLlmUnlock = false;
  let enrich = false;
  if (user) {
    const entitlement = await readShelfEntitlement(env.DB, user.id);
    hasLlmUnlock = entitlement.hasLlmUnlock;
    enrich = entitlement.enrichWithLlm && entitlement.hasLlmUnlock;
  }

  const rates = resolveCreditRates(env);
  const imageRate = rateForAction(rates, CREDIT_ACTION_BOOK_TITLE_IMAGE);
  const summaryRate = rateForAction(rates, CREDIT_ACTION_BOOK_SUMMARY);

  return handleExtractCover(context, {
    userId: user?.id ?? null,
    hasLlmUnlock,
    apiKey: env.FEATHERLESS_API_KEY,
    model: env.FEATHERLESS_VISION_MODEL,
    summaryModel: env.FEATHERLESS_MODEL,
    enrich,
    catalog: createCatalogClient({ googleBooksApiKey: env.GOOGLE_BOOKS_API_KEY }),
    chargeUsage: user
      ? (units) =>
          recordUsage(env.DB, user.id, {
            action: CREDIT_ACTION_BOOK_TITLE_IMAGE,
            amount: imageRate * units,
          })
      : undefined,
    chargeSummary: user
      ? (units) =>
          recordUsage(env.DB, user.id, {
            action: CREDIT_ACTION_BOOK_SUMMARY,
            amount: summaryRate * units,
          })
      : undefined,
  });
};
