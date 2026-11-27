import { describe, expect, it, vi } from "vitest";
import type { APIContext } from "astro";
import { TitleLookupResponseSchema } from "@repo/book-schemas";

/**
 * `cloudflare:workers` only exists on the Workers runtime; stub it so the route
 * module can be imported in Node. The handler reads no globals here — every
 * dependency (fetch, key) is injected per test.
 */
vi.mock("cloudflare:workers", () => ({ env: {} }));

const { handleTitleLookup } = await import("../pages/api/title-lookup");

type LookupContext = Pick<APIContext, "request">;

function makeContext(body: string | Record<string, unknown>): LookupContext {
  const request = new Request("https://tsundoku.test/api/title-lookup", {
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

/** Route a mocked `fetch` by URL and record the URLs it was called with. */
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

function openLibraryHit(): Response {
  return json({
    docs: [
      {
        title: "The Great Gatsby",
        author_name: ["F. Scott Fitzgerald"],
        publisher: ["Scribner"],
        first_publish_year: 1925,
        isbn_13: ["9780743273565"],
      },
    ],
  });
}

function openLibraryMiss(): Response {
  return json({ docs: [] });
}

function googleBooksMiss(): Response {
  return json({ totalItems: 0 });
}

describe("handleTitleLookup", () => {
  describe("400 INVALID_REQUEST", () => {
    it("rejects a malformed JSON body", async () => {
      const response = await handleTitleLookup(makeContext("not-json"));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "INVALID_REQUEST",
      });
    });

    it("rejects a missing title field", async () => {
      const response = await handleTitleLookup(makeContext({}));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "INVALID_REQUEST",
      });
    });

    it("rejects a blank title field", async () => {
      const response = await handleTitleLookup(makeContext({ title: "   " }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "INVALID_REQUEST",
      });
    });
  });

  describe("200 OK", () => {
    it("returns candidate editions from the catalog", async () => {
      const { mock, urls } = mockFetch((url) =>
        url.includes("openlibrary.org") ? openLibraryHit() : googleBooksMiss(),
      );

      const response = await handleTitleLookup(makeContext({ title: "The Great Gatsby" }), {
        fetchImpl: mock,
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(TitleLookupResponseSchema.safeParse(body).success).toBe(true);
      expect(body).toMatchObject({
        editions: [
          {
            title: "The Great Gatsby",
            authors: ["F. Scott Fitzgerald"],
            publisher: "Scribner",
            publishedYear: 1925,
            isbn13: "9780743273565",
            source: "openlibrary",
          },
        ],
      });
      expect(urls.some((url) => url.includes("googleapis.com"))).toBe(false);
    });

    it("returns an empty list when no edition matches", async () => {
      const { mock } = mockFetch((url) =>
        url.includes("openlibrary.org") ? openLibraryMiss() : googleBooksMiss(),
      );

      const response = await handleTitleLookup(makeContext({ title: "Nothing Here" }), {
        fetchImpl: mock,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ editions: [] });
    });

    it("forwards the optional author to the search", async () => {
      const { mock, urls } = mockFetch((url) =>
        url.includes("openlibrary.org") ? openLibraryMiss() : googleBooksMiss(),
      );

      await handleTitleLookup(
        makeContext({ title: "Dune", author: "Frank Herbert" }),
        { fetchImpl: mock, googleBooksApiKey: "google-key" },
      );

      expect(urls[0]).toContain("author=Frank+Herbert");
    });
  });

  describe("502 UPSTREAM_ERROR", () => {
    it("returns 502 when every catalog provider fails", async () => {
      const { mock } = mockFetch(() => {
        throw new Error("network down");
      });

      const response = await handleTitleLookup(makeContext({ title: "Anything" }), {
        fetchImpl: mock,
      });

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        error: "UPSTREAM_ERROR",
      });
    });
  });
});
