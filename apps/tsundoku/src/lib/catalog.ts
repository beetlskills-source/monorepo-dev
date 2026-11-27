import {
  CatalogBookSchema,
  CatalogEditionSchema,
  type CatalogBook,
  type CatalogEdition,
} from "@repo/book-schemas";
import {
  isbn10ToIsbn13,
  isValidIsbn10,
  isValidIsbn13,
  normalizeIsbn,
} from "@repo/isbn";

/**
 * Catalog-first lookup client. Open Library is the primary provider; Google
 * Books is the fallback when Open Library has no match (or errors). Catalog
 * `title` / `authors` are treated as authoritative (`verified: true`).
 * Injectable `fetchImpl` keeps the client deterministic for tests.
 */

export const OPEN_LIBRARY_ENDPOINT = "https://openlibrary.org/api/books";
export const OPEN_LIBRARY_SEARCH_ENDPOINT = "https://openlibrary.org/search.json";
export const GOOGLE_BOOKS_ENDPOINT =
  "https://www.googleapis.com/books/v1/volumes";
export const CATALOG_USER_AGENT = "tsundoku (contact@example.com)";

/** Abort hung upstream requests after this many milliseconds. */
export const DEFAULT_CATALOG_TIMEOUT_MS = 10_000;

/** Maximum editions surfaced per provider for a title/author search. */
export const DEFAULT_EDITION_LIMIT = 10;

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
  /** Find candidate editions by title (and optional author) for the "Read Book Title" fallback. */
  searchEditions(input: CatalogSearchInput): Promise<CatalogEdition[]>;
}

/** Title/author search input for the "Read Book Title" fallback. */
export interface CatalogSearchInput {
  title: string;
  author?: string;
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

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Choose the best ISBN-13 / ISBN-10 pair from a raw identifier list. A real
 * ISBN-13 is preferred over one synthesized from an ISBN-10, and only
 * Bookland-prefixed ISBN-13s survive `isValidIsbn13`.
 */
function pickIdentifiers(raw: readonly string[]): {
  isbn13: string | null;
  isbn10: string | null;
} {
  const normalized = raw.map((value) => normalizeIsbn(value)).filter((v) => v !== "");
  const isbn10 = normalized.find((v) => isValidIsbn10(v)) ?? null;
  const isbn13 =
    normalized.find((v) => isValidIsbn13(v)) ??
    (isbn10 ? isbn10ToIsbn13(isbn10) : null);
  return { isbn13, isbn10 };
}

/** Map one Open Library `search.json` doc into a candidate edition, or `null`. */
function parseOpenLibraryEdition(doc: Record<string, unknown>): CatalogEdition | null {
  const title = isString(doc.title) ? doc.title : "";
  if (title.trim() === "") return null;

  const ids: string[] = [];
  for (const key of ["isbn_13", "isbn_10", "isbn"]) {
    const values = doc[key];
    if (Array.isArray(values)) {
      for (const value of values) if (isString(value)) ids.push(value);
    }
  }
  const { isbn13, isbn10 } = pickIdentifiers(ids);
  const publishers = Array.isArray(doc.publisher)
    ? doc.publisher.filter(isString)
    : [];
  const year =
    typeof doc.first_publish_year === "number"
      ? Math.trunc(doc.first_publish_year)
      : null;

  return CatalogEditionSchema.parse({
    title,
    authors: Array.isArray(doc.author_name) ? doc.author_name.filter(isString) : [],
    publisher: publishers[0] ?? null,
    publishedYear: year,
    isbn13,
    isbn10,
    source: "openlibrary",
  });
}

/** Map one Google Books `volumeInfo` into a candidate edition, or `null`. */
function parseGoogleBooksEdition(item: unknown): CatalogEdition | null {
  const entry = asRecord(item);
  const volume = entry ? asRecord(entry.volumeInfo) : null;
  if (!volume) return null;

  const title = isString(volume.title) ? volume.title : "";
  if (title.trim() === "") return null;

  const ids = Array.isArray(volume.industryIdentifiers)
    ? volume.industryIdentifiers
        .map((identifier) => asRecord(identifier))
        .flatMap((identifier) =>
          identifier && isString(identifier.identifier)
            ? [identifier.identifier]
            : [],
        )
    : [];
  const { isbn13, isbn10 } = pickIdentifiers(ids);

  return CatalogEditionSchema.parse({
    title,
    authors: Array.isArray(volume.authors) ? volume.authors.filter(isString) : [],
    publisher: isString(volume.publisher) ? volume.publisher : null,
    publishedYear: extractYear(volume.publishedDate),
    isbn13,
    isbn10,
    source: "google-books",
  });
}

/** Strip characters that would break a Google Books `intitle:`/`inauthor:` term. */
function sanitizeQueryTerm(value: string): string {
  return value.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
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

  async function searchOpenLibrary(
    input: CatalogSearchInput,
  ): Promise<CatalogEdition[]> {
    const params = new URLSearchParams();
    params.set("title", input.title);
    if (input.author) params.set("author", input.author);
    params.set(
      "fields",
      "title,author_name,publisher,first_publish_year,isbn,isbn_13,isbn_10",
    );
    params.set("limit", String(DEFAULT_EDITION_LIMIT));
    const url = `${OPEN_LIBRARY_SEARCH_ENDPOINT}?${params.toString()}`;
    const data = await fetchJson(url, { "user-agent": CATALOG_USER_AGENT });
    const root = asRecord(data);
    const docs = root && Array.isArray(root.docs) ? root.docs : [];
    return docs.flatMap((doc) => {
      const record = asRecord(doc);
      const edition = record ? parseOpenLibraryEdition(record) : null;
      return edition ? [edition] : [];
    });
  }

  /** Run a Google Books volumes query for `query` (an `intitle:`/plain term). */
  async function searchGoogleBooks(query: string): Promise<CatalogEdition[]> {
    const base = `${GOOGLE_BOOKS_ENDPOINT}?q=${encodeURIComponent(
      query,
    )}&maxResults=${DEFAULT_EDITION_LIMIT}`;
    const url = googleBooksApiKey
      ? `${base}&key=${encodeURIComponent(googleBooksApiKey)}`
      : base;
    let data: unknown;
    try {
      data = await fetchJson(url, { "user-agent": CATALOG_USER_AGENT });
    } catch (error) {
      if (error instanceof CatalogError && error.status === 429) {
        return [];
      }
      throw error;
    }
    const root = asRecord(data);
    const items = root && Array.isArray(root.items) ? root.items : [];
    return items.flatMap((item) => {
      const edition = parseGoogleBooksEdition(item);
      return edition ? [edition] : [];
    });
  }

  async function searchEditions(
    input: CatalogSearchInput,
  ): Promise<CatalogEdition[]> {
    const title = input.title.trim();
    if (title === "") return [];

    let sawEmpty = false;
    let sawError = false;

    try {
      const editions = await searchOpenLibrary({ title, author: input.author });
      if (editions.length > 0) return editions;
      sawEmpty = true;
    } catch {
      sawError = true;
    }

    // Google Books fallback: a precise `intitle:`/`inauthor:` query first, then
    // a plain free-text `q=` search so hyphenated or punctuated titles still hit.
    const term = sanitizeQueryTerm(title);
    const author = input.author ? sanitizeQueryTerm(input.author) : "";
    const refined = author
      ? `intitle:${term} inauthor:${author}`
      : `intitle:${term}`;
    const plain = author ? `${term} ${author}` : term;

    for (const query of [refined, plain]) {
      if (query.trim() === "") continue;
      try {
        const editions = await searchGoogleBooks(query);
        if (editions.length > 0) return editions;
        sawEmpty = true;
      } catch {
        sawError = true;
      }
    }

    if (sawEmpty) return [];
    if (sawError) throw new CatalogError("All catalog providers failed");
    return [];
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
    searchEditions,
  };
}
