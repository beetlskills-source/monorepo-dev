import { describe, expect, it, vi } from "vitest";
import type { APIContext } from "astro";
import { BookLookupResultSchema } from "@repo/book-schemas";

/**
 * `cloudflare:workers` only exists on the Workers runtime; stub it so the route
 * module can be imported in Node. The handler itself reads no globals here —
 * every dependency is injected per test.
 */
vi.mock("cloudflare:workers", () => ({ env: {} }));

const { handleIsbnLookup } = await import("../pages/api/isbn-lookup");

const VALID_ISBN13 = "9780306406157";
const VALID_ISBN10 = "0306406152";

type LookupContext = Pick<APIContext, "request">;

function makeContext(body: string | Record<string, unknown>): LookupContext {
  const request = new Request("https://tsundoku.test/api/isbn-lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { request };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** An Open Library `jscmd=data` payload containing the given ISBN. */
function openLibraryHit(
  isbn13: string,
  overrides: Record<string, unknown> = {},
): Response {
  return json({
    [`ISBN:${isbn13}`]: {
      title: "The C Programming Language",
      authors: [{ name: "Brian W. Kernighan" }, { name: "Dennis M. Ritchie" }],
      publishers: [{ name: "Prentice Hall" }],
      publish_date: "1978",
      ...overrides,
    },
  });
}

function openLibraryMiss(): Response {
  return json({});
}

function googleBooksHit(
  overrides: Record<string, unknown> = {},
): Response {
  return json({
    totalItems: 1,
    items: [
      {
        volumeInfo: {
          title: "Google Book",
          authors: ["Google Author"],
          publisher: "G Books",
          publishedDate: "2001-05-01",
          ...overrides,
        },
      },
    ],
  });
}

function googleBooksMiss(): Response {
  return json({ totalItems: 0 });
}

function featherlessResponse(content: string, status = 200): Response {
  return json({ choices: [{ message: { content } }] }, status);
}

function enrichmentContent(summary: string | null, topics?: string[]): string {
  return JSON.stringify(topics ? { summary, topics } : { summary });
}

/**
 * Route a mocked `fetch` by URL so catalog (Open Library / Google Books) and
 * enrichment (Featherless) calls are separable. Records every URL it sees.
 */
function mockFetch(router: (url: string) => Response) {
  const urls: string[] = [];
  const mock = vi.fn((input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    urls.push(url);
    return Promise.resolve(router(url));
  });
  return { mock: mock as unknown as typeof fetch, urls };
}

const BASE_DEPS = { apiKey: "test-key" } as const;

describe("handleIsbnLookup", () => {
  describe("400 INVALID_ISBN", () => {
    it("rejects a malformed JSON body", async () => {
      const response = await handleIsbnLookup(makeContext("not-json"), BASE_DEPS);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "INVALID_ISBN",
      });
    });

    it("rejects a missing isbn field", async () => {
      const response = await handleIsbnLookup(makeContext({}), BASE_DEPS);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "INVALID_ISBN",
      });
    });

    it("rejects an empty isbn field", async () => {
      const response = await handleIsbnLookup(makeContext({ isbn: "" }), BASE_DEPS);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "INVALID_ISBN",
      });
    });

    it("rejects a non-ISBN string", async () => {
      const response = await handleIsbnLookup(
        makeContext({ isbn: "hello world" }),
        BASE_DEPS,
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "INVALID_ISBN",
      });
    });

    it("rejects an invalid check digit", async () => {
      const response = await handleIsbnLookup(
        makeContext({ isbn: "9780306406158" }),
        BASE_DEPS,
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "INVALID_ISBN",
      });
    });
  });

  describe("enrichment without a key", () => {
    it("skips enrichment and still returns the catalog result when FEATHERLESS_API_KEY is missing", async () => {
      const { mock, urls } = mockFetch((url) =>
        url.includes("openlibrary.org")
          ? openLibraryHit(VALID_ISBN13)
          : featherlessResponse(enrichmentContent("should not be used")),
      );

      const response = await handleIsbnLookup(makeContext({ isbn: VALID_ISBN13 }), {
        fetchImpl: mock,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        title: "The C Programming Language",
        source: "openlibrary",
        verified: true,
        summary: null,
        enriched: false,
      });
      expect(urls.some((url) => url.includes("featherless"))).toBe(false);
    });
  });

  describe("422 BOOK_NOT_FOUND", () => {
    it("returns 422 when no catalog provider matches and never calls the LLM", async () => {
      const { mock, urls } = mockFetch((url) => {
        if (url.includes("openlibrary.org")) return openLibraryMiss();
        return googleBooksMiss();
      });

      const response = await handleIsbnLookup(makeContext({ isbn: VALID_ISBN13 }), {
        ...BASE_DEPS,
        fetchImpl: mock,
      });

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: "BOOK_NOT_FOUND",
      });
      expect(urls.some((url) => url.includes("featherless"))).toBe(false);
    });
  });

  describe("200 OK — catalog-first identity", () => {
    it("returns Open Library identity and does not query Google Books on a hit", async () => {
      const { mock, urls } = mockFetch((url) =>
        url.includes("openlibrary.org")
          ? openLibraryHit(VALID_ISBN13)
          : featherlessResponse(enrichmentContent("A classic reference.", ["programming"])),
      );

      const response = await handleIsbnLookup(makeContext({ isbn: VALID_ISBN13 }), {
        ...BASE_DEPS,
        fetchImpl: mock,
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(BookLookupResultSchema.safeParse(body).success).toBe(true);
      expect(body).toMatchObject({
        isbn13: VALID_ISBN13,
        title: "The C Programming Language",
        authors: ["Brian W. Kernighan", "Dennis M. Ritchie"],
        publisher: "Prentice Hall",
        publishedYear: 1978,
        summary: "A classic reference.",
        source: "openlibrary",
        verified: true,
        enriched: true,
        confidence: "high",
      });
      expect(urls.some((url) => url.includes("googleapis.com"))).toBe(false);
    });

    it("falls back to Google Books when Open Library has no match", async () => {
      const { mock, urls } = mockFetch((url) => {
        if (url.includes("openlibrary.org")) return openLibraryMiss();
        if (url.includes("googleapis.com")) return googleBooksHit();
        return featherlessResponse(enrichmentContent(null));
      });

      const response = await handleIsbnLookup(makeContext({ isbn: VALID_ISBN13 }), {
        ...BASE_DEPS,
        googleBooksApiKey: "google-key",
        fetchImpl: mock,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        title: "Google Book",
        authors: ["Google Author"],
        publisher: "G Books",
        publishedYear: 2001,
        source: "google-books",
        verified: true,
        enriched: false,
        summary: null,
      });

      const googleUrl = urls.find((url) => url.includes("googleapis.com"));
      expect(googleUrl).toContain(`q=isbn:${VALID_ISBN13}`);
      expect(googleUrl).toContain("key=google-key");
    });

    it("normalizes an ISBN-10 request into a 13-digit response", async () => {
      const { mock, urls } = mockFetch((url) =>
        url.includes("openlibrary.org")
          ? openLibraryHit(VALID_ISBN13)
          : featherlessResponse(enrichmentContent("Summary.")),
      );

      const response = await handleIsbnLookup(makeContext({ isbn: VALID_ISBN10 }), {
        ...BASE_DEPS,
        fetchImpl: mock,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        isbn13: VALID_ISBN13,
        title: "The C Programming Language",
      });
      expect(urls.find((url) => url.includes("openlibrary.org"))).toContain(
        `ISBN:${VALID_ISBN13}`,
      );
    });
  });

  describe("200 OK — graceful enrichment", () => {
    it("degrades to enriched:false when Featherless fails, preserving the catalog result", async () => {
      const { mock } = mockFetch((url) =>
        url.includes("openlibrary.org")
          ? openLibraryHit(VALID_ISBN13)
          : featherlessResponse("upstream boom", 500),
      );

      const response = await handleIsbnLookup(makeContext({ isbn: VALID_ISBN13 }), {
        ...BASE_DEPS,
        fetchImpl: mock,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        title: "The C Programming Language",
        authors: ["Brian W. Kernighan", "Dennis M. Ritchie"],
        summary: null,
        verified: true,
        enriched: false,
      });
    });

    it("treats a null summary as absence (enriched:false)", async () => {
      const { mock } = mockFetch((url) =>
        url.includes("openlibrary.org")
          ? openLibraryHit(VALID_ISBN13)
          : featherlessResponse(enrichmentContent(null)),
      );

      const response = await handleIsbnLookup(makeContext({ isbn: VALID_ISBN13 }), {
        ...BASE_DEPS,
        fetchImpl: mock,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        summary: null,
        enriched: false,
      });
    });

    it("never lets enrichment output overwrite verified title or authors", async () => {
      const { mock } = mockFetch((url) =>
        url.includes("openlibrary.org")
          ? openLibraryHit(VALID_ISBN13)
          : featherlessResponse(
              JSON.stringify({
                summary: "Hijacked.",
                title: "HACKED TITLE",
                authors: ["Evil Author"],
              }),
            ),
      );

      const response = await handleIsbnLookup(makeContext({ isbn: VALID_ISBN13 }), {
        ...BASE_DEPS,
        fetchImpl: mock,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        title: "The C Programming Language",
        authors: ["Brian W. Kernighan", "Dennis M. Ritchie"],
        summary: "Hijacked.",
        enriched: true,
      });
    });

    it("parses markdown-fenced JSON from the model", async () => {
      const { mock } = mockFetch((url) =>
        url.includes("openlibrary.org")
          ? openLibraryHit(VALID_ISBN13)
          : featherlessResponse("```json\n" + enrichmentContent("Fenced.") + "\n```"),
      );

      const response = await handleIsbnLookup(makeContext({ isbn: VALID_ISBN13 }), {
        ...BASE_DEPS,
        fetchImpl: mock,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        summary: "Fenced.",
        enriched: true,
      });
    });

    it("normalizes loosely-typed enrichment output before validating", async () => {
      const { mock } = mockFetch((url) =>
        url.includes("openlibrary.org")
          ? openLibraryHit(VALID_ISBN13)
          : featherlessResponse(
              JSON.stringify({ summary: "  Kept summary.  ", topics: "programming" }),
            ),
      );

      const response = await handleIsbnLookup(makeContext({ isbn: VALID_ISBN13 }), {
        ...BASE_DEPS,
        fetchImpl: mock,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        summary: "Kept summary.",
        enriched: true,
      });
    });
  });

  describe("Google Books rate limiting", () => {
    it("treats a Google Books 429 as a non-fatal miss and returns 422", async () => {
      const { mock, urls } = mockFetch((url) => {
        if (url.includes("openlibrary.org")) return openLibraryMiss();
        if (url.includes("googleapis.com")) {
          return json({ error: "rate limited" }, 429);
        }
        return featherlessResponse(enrichmentContent("unused"));
      });

      const response = await handleIsbnLookup(makeContext({ isbn: VALID_ISBN13 }), {
        ...BASE_DEPS,
        fetchImpl: mock,
      });

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: "BOOK_NOT_FOUND",
      });
      expect(urls.some((url) => url.includes("featherless"))).toBe(false);
    });
  });

  describe("502 UPSTREAM_ERROR", () => {
    it("returns 502 when every catalog provider fails and never leaks the API key", async () => {
      const { mock, urls } = mockFetch(() => {
        throw new Error("network down");
      });

      const response = await handleIsbnLookup(makeContext({ isbn: VALID_ISBN13 }), {
        apiKey: "super-secret-key",
        fetchImpl: mock,
      });

      expect(response.status).toBe(502);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ error: "UPSTREAM_ERROR" });
      expect(text).not.toContain("super-secret-key");
      expect(urls.some((url) => url.includes("featherless"))).toBe(false);
    });

    it("returns 502 when a catalog provider responds with a non-2xx status", async () => {
      const { mock } = mockFetch(() => json({ error: "boom" }, 500));

      const response = await handleIsbnLookup(makeContext({ isbn: VALID_ISBN13 }), {
        ...BASE_DEPS,
        fetchImpl: mock,
      });

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        error: "UPSTREAM_ERROR",
      });
    });
  });
});
