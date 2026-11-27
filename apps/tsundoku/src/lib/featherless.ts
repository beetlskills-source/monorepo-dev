import {
  BookEnrichmentSchema,
  CoverExtractionSchema,
  type BookEnrichment,
  type CatalogBook,
  type CoverExtraction,
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
 * Default multimodal model, used when `FEATHERLESS_VISION_MODEL` is not
 * configured. A vision-language model that accepts OpenAI-style
 * `type: "image_url"` content parts.
 */
export const DEFAULT_FEATHERLESS_VISION_MODEL = "Qwen/Qwen2.5-VL-7B-Instruct";

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

/**
 * One book in a bulk enrichment request. `key` is an opaque caller correlation
 * token (e.g. a spreadsheet row index) echoed back in the result so the caller
 * can map a returned `summary` to its exact source row even when two rows share
 * an ISBN.
 */
export interface BatchEnrichmentInput {
  key: string;
  isbn13: string;
  title: string;
  authors: string[];
  publisher?: string | null;
  publishedYear?: number | null;
}

/** Correlation key → non-empty summary, for books the model could enrich. */
export type BatchEnrichmentMap = Map<string, string>;

/**
 * OpenAI-compatible chat content: either a plain string or a multimodal parts
 * array (`text` + `image_url`), matching the Featherless `chat/completions`
 * contract for vision models.
 */
export type ChatMessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

export interface ChatMessage {
  role: string;
  content: ChatMessageContent;
}

export interface FeatherlessClient {
  /** Enrich a catalog-verified book with a summary (and optional topics). */
  enrichBook(book: CatalogBook): Promise<BookEnrichment>;
  /**
   * Enrich many books in a single request, returning a `key → summary` map.
   * Books the model cannot summarise are simply absent from the map.
   */
  enrichBooks(books: BatchEnrichmentInput[]): Promise<BatchEnrichmentMap>;
  /**
   * Read title/subtitle/authors/publisher/isbn hints off a book cover photo (a
   * base64 `data:` URL). Uses the client's configured (multimodal) model. The
   * result is grounded-only (null/empty for anything not clearly visible) and
   * is treated by the caller as a lookup hint, not authoritative metadata.
   */
  extractCover(imageDataUrl: string): Promise<CoverExtraction>;
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

const BATCH_SYSTEM_PROMPT = [
  "You enrich catalog-verified book metadata in bulk.",
  "Respond with a single strict JSON object and nothing else.",
  "The object must match exactly this shape:",
  '{"summaries": [{"key": string, "summary": string | null}]}',
  "Return exactly one entry per input book, echoing its key unchanged.",
  "Write a concise 2-4 sentence summary grounded only in the provided title",
  "and authors. If you are unsure, set summary to null rather than guessing.",
  "Never add or restate a title or author list in your output.",
].join(" ");

const VISION_SYSTEM_PROMPT = [
  "You read book metadata from a photo of a book cover.",
  "Respond with a single strict JSON object and nothing else.",
  "The object must match exactly this shape:",
  '{"title": string, "subtitle": string | null, "authors": string[], "publisher": string | null, "isbn": string | null}',
  "Combine a multi-line display title into ONE coherent title string:",
  'split lines "The $100" / "Startup" become "The $100 Startup",',
  '"Rocks" / "& Minerals" becomes "Rocks & Minerals", and Chinese cover',
  "titles are joined without inserting spaces.",
  "Read English covers and Chinese covers accurately, including Simplified and",
  "Traditional Chinese. Keep a secondary/subtitle line in 'subtitle', not 'title'.",
  "Keep 'title' a clean book title ONLY: never prefix it with the author's",
  "name or a possessive, e.g. output \"The $100 Startup\", never",
  "\"Chris Guillebeau's The $100 Startup\" or \"by Chris Guillebeau\".",
  "Ground every value in the pixels you can actually see. Return an author in",
  "'authors' ONLY when that name is clearly printed and legible on the cover:",
  "if the author text is blurry, cut off, absent, or you are unsure, return an",
  "empty array. Never guess an author from prior knowledge, the title, or the",
  "topic.",
  "Include 'publisher' only when it is clearly printed on the cover.",
  "Include 'isbn' only when the digits are clearly legible, and return them as a",
  "plain string of digits (no hyphens); otherwise use null.",
  "For any field you cannot read clearly, use null (or an empty array for",
  "authors) instead of guessing.",
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
 * Coerce a batch model response into a `key → summary` map, keeping only
 * entries with a non-blank key and a non-blank summary. A missing `summaries`
 * list is an upstream error; individual malformed entries are skipped so one
 * bad row never discards the whole batch.
 */
function normalizeBatchSummaries(
  parsed: Record<string, unknown>,
): BatchEnrichmentMap {
  const entries = parsed.summaries;
  if (!Array.isArray(entries)) {
    throw new UpstreamError("Featherless batch output was missing a summaries list");
  }

  const result: BatchEnrichmentMap = new Map();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const key = typeof record.key === "string" ? record.key.trim() : "";
    const summary =
      typeof record.summary === "string" ? record.summary.trim() : "";
    if (key !== "" && summary !== "") {
      result.set(key, summary);
    }
  }
  return result;
}

/** Build the user message listing every book in a batch request. */
function buildBatchContext(books: BatchEnrichmentInput[]): string {
  const payload = {
    books: books.map((book) => ({
      key: book.key,
      isbn13: book.isbn13,
      title: book.title,
      authors: book.authors,
      publisher: book.publisher ?? null,
      publishedYear: book.publishedYear ?? null,
    })),
  };
  return `Enrich these books:\n${JSON.stringify(payload)}`;
}

/**
 * Coerce loosely-typed vision output into {@link CoverExtractionSchema}'s shape
 * before validation: a blank title/subtitle/publisher/isbn becomes `null`,
 * authors keep only non-empty strings, and any stray newlines in the title
 * collapse to single spaces so a multi-line display title arrives as one clean
 * clause. Author grounding (empty when nothing is legible) is enforced by the
 * prompt; `isbn` is kept as an unvalidated lookup hint.
 */
function normalizeCover(parsed: Record<string, unknown>): unknown {
  const title =
    typeof parsed.title === "string"
      ? parsed.title.trim().replace(/\s+/g, " ")
      : "";
  const subtitle =
    typeof parsed.subtitle === "string" ? parsed.subtitle.trim() : "";
  const publisher =
    typeof parsed.publisher === "string" ? parsed.publisher.trim() : "";
  const isbn = typeof parsed.isbn === "string" ? parsed.isbn.trim() : "";
  const authors = Array.isArray(parsed.authors)
    ? parsed.authors
        .filter((author): author is string => typeof author === "string")
        .map((author) => author.trim())
        .filter((author) => author !== "")
    : [];

  return {
    title,
    subtitle: subtitle === "" ? null : subtitle,
    authors,
    publisher: publisher === "" ? null : publisher,
    isbn: isbn === "" ? null : isbn,
  };
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

  /**
   * POST one completion and return the parsed JSON object from the model's
   * message. Shared by the single and batch methods so both inherit the same
   * timeout, error, and fence-handling behaviour.
   */
  async function callModel(
    messages: ChatMessage[],
  ): Promise<Record<string, unknown>> {
    const payload = {
      model,
      temperature,
      messages,
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

    return parseModelJson(content);
  }

  return {
    async enrichBook(book: CatalogBook): Promise<BookEnrichment> {
      const parsed = await callModel([
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Enrich this book:\n${buildBookContext(book)}`,
        },
      ]);

      const result = BookEnrichmentSchema.safeParse(normalizeEnrichment(parsed));
      if (!result.success) {
        throw new UpstreamError("Featherless output failed schema validation");
      }

      return result.data;
    },

    async enrichBooks(
      books: BatchEnrichmentInput[],
    ): Promise<BatchEnrichmentMap> {
      // Nothing to ask for; skip the upstream call entirely.
      if (books.length === 0) return new Map();

      const parsed = await callModel([
        { role: "system", content: BATCH_SYSTEM_PROMPT },
        { role: "user", content: buildBatchContext(books) },
      ]);

      return normalizeBatchSummaries(parsed);
    },

    async extractCover(imageDataUrl: string): Promise<CoverExtraction> {
      const parsed = await callModel([
        { role: "system", content: VISION_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract the title, subtitle, authors, publisher, and ISBN from this book cover. Only report text you can clearly see.",
            },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ]);

      const result = CoverExtractionSchema.safeParse(normalizeCover(parsed));
      if (!result.success) {
        throw new UpstreamError(
          "Featherless vision output failed schema validation",
        );
      }

      return result.data;
    },
  };
}
