import {
  BookEnrichmentSchema,
  type BookEnrichment,
  type CatalogBook,
} from "@repo/book-schemas";

/**
 * Featherless AI enrichment client. Given a catalog-verified book, it produces
 * a concise `summary` (and optional `topics`) only. It never returns or
 * overwrites `title` / `authors`; the caller owns those authoritative fields.
 * Injectable `fetchImpl` keeps the client deterministic for tests.
 */

export const FEATHERLESS_ENDPOINT =
  "https://api.featherless.ai/v1/chat/completions";

/** Default model, used when `FEATHERLESS_MODEL` is not configured. */
export const DEFAULT_FEATHERLESS_MODEL = "meta-llama/Meta-Llama-3.1-8B-Instruct";

/**
 * Abort hung upstream requests after this many milliseconds. A large instruct
 * model (e.g. the configured 70B model) routinely needs 10-20s to answer, so the
 * budget must stay comfortably above that. An over-tight value aborts the
 * request, and because enrichment degrades gracefully the abort is swallowed by
 * the caller and silently turns every lookup into `enriched: false`.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Low temperature keeps output deterministic and strictly JSON-formatted. */
export const DEFAULT_TEMPERATURE = 0.1;

/** Raised when the Featherless API fails, times out, or returns invalid output. */
export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface FeatherlessClientOptions {
  apiKey: string;
  model?: string;
  /** Injectable fetch implementation, mainly for tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  temperature?: number;
}

export interface FeatherlessClient {
  /** Enrich a catalog-verified book with a summary (and optional topics). */
  enrichBook(book: CatalogBook): Promise<BookEnrichment>;
}

const SYSTEM_PROMPT = [
  "You enrich catalog-verified book metadata.",
  "Respond with a single strict JSON object and nothing else.",
  "The object must match exactly this shape:",
  '{"summary": string | null,',
  '"topics"?: string[]}',
  "Write a concise 2-4 sentence summary grounded only in the provided title",
  "and authors. If you are unsure, set summary to null rather than guessing.",
  "Never add or restate a title or author list in your output.",
].join(" ");

/** Remove a surrounding ```json ... ``` markdown fence, if present. */
function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? (fenced[1] as string).trim() : trimmed;
}

function extractMessageContent(data: unknown): string | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

function parseModelJson(text: string): Record<string, unknown> {
  const cleaned = stripMarkdownFences(text);
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch {
    throw new UpstreamError("Featherless output was not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UpstreamError("Featherless output was not a JSON object");
  }
  return value as Record<string, unknown>;
}

/**
 * Coerce loosely-typed model output into the schema's expected types before
 * validation: a blank/non-string `summary` becomes `null`, and `topics` is kept
 * only when it is a list of non-empty strings. This preserves otherwise-useful
 * enrichment (e.g. a good summary alongside malformed topics) instead of
 * discarding the whole response.
 */
function normalizeEnrichment(parsed: Record<string, unknown>): BookEnrichment {
  const rawSummary = parsed.summary;
  const summary =
    typeof rawSummary === "string" && rawSummary.trim() !== ""
      ? rawSummary.trim()
      : null;

  let topics: string[] | undefined;
  if (Array.isArray(parsed.topics)) {
    const cleaned = parsed.topics
      .filter((topic): topic is string => typeof topic === "string")
      .map((topic) => topic.trim())
      .filter((topic) => topic !== "");
    if (cleaned.length > 0) {
      topics = cleaned;
    }
  }

  return topics ? { summary, topics } : { summary };
}

/** Build the user message describing the catalog-verified book. */
function buildBookContext(book: CatalogBook): string {
  const lines = [
    `ISBN-13: ${book.isbn13}`,
    `Title: ${book.title}`,
    `Authors: ${book.authors.length > 0 ? book.authors.join(", ") : "unknown"}`,
  ];
  if (book.publisher) {
    lines.push(`Publisher: ${book.publisher}`);
  }
  if (book.publishedYear) {
    lines.push(`Published: ${book.publishedYear}`);
  }
  return lines.join("\n");
}

/**
 * Create an injectable Featherless AI enrichment client. The client never reads
 * secrets itself; the caller passes the server-side API key explicitly.
 */
export function createFeatherlessClient(
  options: FeatherlessClientOptions,
): FeatherlessClient {
  const {
    apiKey,
    model = DEFAULT_FEATHERLESS_MODEL,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    temperature = DEFAULT_TEMPERATURE,
  } = options;

  return {
    async enrichBook(book: CatalogBook): Promise<BookEnrichment> {
      const payload = {
        model,
        temperature,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Enrich this book:\n${buildBookContext(book)}`,
          },
        ],
        response_format: { type: "json_object" },
      };

      let response: Response;
      try {
        response = await fetchImpl(FEATHERLESS_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new UpstreamError("Featherless request failed or timed out");
      }

      if (!response.ok) {
        throw new UpstreamError(
          `Featherless responded with status ${response.status}`,
        );
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new UpstreamError("Featherless returned an invalid JSON response");
      }

      const content = extractMessageContent(data);
      if (content === null) {
        throw new UpstreamError("Featherless response was missing message content");
      }

      const parsed = parseModelJson(content);
      const result = BookEnrichmentSchema.safeParse(normalizeEnrichment(parsed));
      if (!result.success) {
        throw new UpstreamError("Featherless output failed schema validation");
      }

      return result.data;
    },
  };
}
