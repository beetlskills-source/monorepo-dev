import { CatalogBookSchema, type CatalogBook } from "@repo/book-schemas";

/**
 * Catalog-first lookup client. Open Library is the primary provider; Google
 * Books is the fallback when Open Library has no match (or errors). Catalog
 * `title` / `authors` are treated as authoritative (`verified: true`).
 * Injectable `fetchImpl` keeps the client deterministic for tests.
 */

export const OPEN_LIBRARY_ENDPOINT = "https://openlibrary.org/api/books";
export const GOOGLE_BOOKS_ENDPOINT =
  "https://www.googleapis.com/books/v1/volumes";
export const CATALOG_USER_AGENT = "tsundoku (contact@example.com)";

/** Abort hung upstream requests after this many milliseconds. */
export const DEFAULT_CATALOG_TIMEOUT_MS = 10_000;

/** Raised when a catalog provider fails at the network/HTTP boundary. */
export class CatalogError extends Error {
  /** HTTP status from the provider, when the failure was an HTTP response. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "CatalogError";
    this.status = status;
  }
}

export interface CatalogClientOptions {
  /** Injectable fetch implementation, mainly for tests. */
  fetchImpl?: typeof fetch;
  /** Optional Google Books API key, appended as `&key=<key>`. */
  googleBooksApiKey?: string;
  timeoutMs?: number;
}

export interface CatalogClient {
  /** Resolve a normalized ISBN-13 to an authoritative catalog record. */
  lookupByIsbn(isbn13: string): Promise<CatalogBook | null>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Pull a 4-digit year out of any catalog date string, or `null`. */
function extractYear(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/\d{4}/);
  if (!match) {
    return null;
  }
  const year = Number(match[0]);
  return Number.isInteger(year) ? year : null;
}

function openLibraryAuthors(record: Record<string, unknown>): string[] {
  const authors = record.authors;
  if (!Array.isArray(authors)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of authors) {
    const author = asRecord(entry);
    if (author && typeof author.name === "string") {
      names.push(author.name);
    }
  }
  return names;
}

function openLibraryPublisher(record: Record<string, unknown>): string | null {
  const publishers = record.publishers;
  if (!Array.isArray(publishers)) {
    return null;
  }
  for (const entry of publishers) {
    const publisher = asRecord(entry);
    if (publisher && typeof publisher.name === "string") {
      return publisher.name;
    }
  }
  return null;
}

/** Map an Open Library `jscmd=data` payload into a `CatalogBook`, or `null`. */
function parseOpenLibrary(isbn13: string, data: unknown): CatalogBook | null {
  const root = asRecord(data);
  if (!root) {
    return null;
  }
  const record = asRecord(root[`ISBN:${isbn13}`]);
  if (!record) {
    return null;
  }
  const title = typeof record.title === "string" ? record.title : "";
  if (title.trim() === "") {
    return null;
  }
  return CatalogBookSchema.parse({
    isbn13,
    title,
    authors: openLibraryAuthors(record),
    publisher: openLibraryPublisher(record),
    publishedYear: extractYear(record.publish_date),
    source: "openlibrary",
    verified: true,
  });
}

function googleAuthors(volume: Record<string, unknown>): string[] {
  const authors = volume.authors;
  if (!Array.isArray(authors)) {
    return [];
  }
  return authors.filter((author): author is string => typeof author === "string");
}

/** Map a Google Books `volumes` payload into a `CatalogBook`, or `null`. */
function parseGoogleBooks(isbn13: string, data: unknown): CatalogBook | null {
  const root = asRecord(data);
  if (!root) {
    return null;
  }
  const items = root.items;
  if (!Array.isArray(items)) {
    return null;
  }
  for (const item of items) {
    const entry = asRecord(item);
    const volume = entry ? asRecord(entry.volumeInfo) : null;
    if (!volume) {
      continue;
    }
    const title = typeof volume.title === "string" ? volume.title : "";
    if (title.trim() === "") {
      continue;
    }
    return CatalogBookSchema.parse({
      isbn13,
      title,
      authors: googleAuthors(volume),
      publisher: typeof volume.publisher === "string" ? volume.publisher : null,
      publishedYear: extractYear(volume.publishedDate),
      source: "google-books",
      verified: true,
    });
  }
  return null;
}

/**
 * Create an injectable catalog client. The client never reads secrets itself;
 * the optional Google Books API key is passed in by the caller.
 */
export function createCatalogClient(
  options: CatalogClientOptions = {},
): CatalogClient {
  const {
    fetchImpl = fetch,
    googleBooksApiKey,
    timeoutMs = DEFAULT_CATALOG_TIMEOUT_MS,
  } = options;

  async function fetchJson(
    url: string,
    headers: Record<string, string>,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new CatalogError("Catalog request failed or timed out");
    }
    if (!response.ok) {
      throw new CatalogError(
        `Catalog responded with status ${response.status}`,
        response.status,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new CatalogError("Catalog returned an invalid JSON response");
    }
  }

  async function lookupOpenLibrary(isbn13: string): Promise<CatalogBook | null> {
    const url = `${OPEN_LIBRARY_ENDPOINT}?bibkeys=ISBN:${isbn13}&format=json&jscmd=data`;
    const data = await fetchJson(url, { "user-agent": CATALOG_USER_AGENT });
    return parseOpenLibrary(isbn13, data);
  }

  async function lookupGoogleBooks(isbn13: string): Promise<CatalogBook | null> {
    const base = `${GOOGLE_BOOKS_ENDPOINT}?q=isbn:${isbn13}`;
    const url = googleBooksApiKey
      ? `${base}&key=${encodeURIComponent(googleBooksApiKey)}`
      : base;
    let data: unknown;
    try {
      data = await fetchJson(url, { "user-agent": CATALOG_USER_AGENT });
    } catch (error) {
      // A rate-limited (429) Google Books response is a transient, non-fatal
      // miss rather than a hard upstream failure.
      if (error instanceof CatalogError && error.status === 429) {
        return null;
      }
      throw error;
    }
    return parseGoogleBooks(isbn13, data);
  }

  return {
    async lookupByIsbn(isbn13: string): Promise<CatalogBook | null> {
      let sawEmpty = false;
      let sawError = false;

      try {
        const book = await lookupOpenLibrary(isbn13);
        if (book) {
          return book;
        }
        sawEmpty = true;
      } catch {
        sawError = true;
      }

      try {
        const book = await lookupGoogleBooks(isbn13);
        if (book) {
          return book;
        }
        sawEmpty = true;
      } catch {
        sawError = true;
      }

      // A definitive empty result from any provider means "not found"; only
      // when every provider errored do we surface an upstream failure.
      if (sawEmpty) {
        return null;
      }
      if (sawError) {
        throw new CatalogError("All catalog providers failed");
      }
      return null;
    },
  };
}
