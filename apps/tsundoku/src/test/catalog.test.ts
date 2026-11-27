import { describe, expect, it, vi } from "vitest";
import { CatalogError, createCatalogClient } from "../lib/catalog";

const ISBN13 = "9780306406157";

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

describe("createCatalogClient", () => {
  it("maps an Open Library hit into a verified catalog record", async () => {
    const { mock, urls } = mockFetch(() =>
      json({
        [`ISBN:${ISBN13}`]: {
          title: "The C Programming Language",
          authors: [{ name: "Brian W. Kernighan" }, { name: "Dennis M. Ritchie" }],
          publishers: [{ name: "Prentice Hall" }],
          publish_date: "March 1978",
        },
      }),
    );

    const client = createCatalogClient({ fetchImpl: mock });

    await expect(client.lookupByIsbn(ISBN13)).resolves.toEqual({
      isbn13: ISBN13,
      title: "The C Programming Language",
      authors: ["Brian W. Kernighan", "Dennis M. Ritchie"],
      publisher: "Prentice Hall",
      publishedYear: 1978,
      source: "openlibrary",
      verified: true,
    });
    expect(urls[0]).toContain(`bibkeys=ISBN:${ISBN13}`);
    expect(urls.some((url) => url.includes("googleapis.com"))).toBe(false);
  });

  it("falls back to Google Books when Open Library has no match", async () => {
    const { mock, urls } = mockFetch((url) =>
      url.includes("openlibrary.org")
        ? json({})
        : json({
            totalItems: 1,
            items: [
              {
                volumeInfo: {
                  title: "Google Book",
                  authors: ["Google Author"],
                  publishedDate: "2001-05-01",
                },
              },
            ],
          }),
    );

    const client = createCatalogClient({ fetchImpl: mock });

    await expect(client.lookupByIsbn(ISBN13)).resolves.toEqual({
      isbn13: ISBN13,
      title: "Google Book",
      authors: ["Google Author"],
      publisher: null,
      publishedYear: 2001,
      source: "google-books",
      verified: true,
    });
    const googleUrl = urls.find((url) => url.includes("googleapis.com"));
    expect(googleUrl).toContain(`q=isbn:${ISBN13}`);
    expect(googleUrl).not.toContain("key=");
  });

  it("appends the Google Books API key when configured", async () => {
    const { mock, urls } = mockFetch((url) =>
      url.includes("openlibrary.org") ? json({}) : json({ totalItems: 0 }),
    );

    const client = createCatalogClient({
      fetchImpl: mock,
      googleBooksApiKey: "abc key",
    });

    await expect(client.lookupByIsbn(ISBN13)).resolves.toBeNull();
    expect(urls.find((url) => url.includes("googleapis.com"))).toContain(
      "key=abc%20key",
    );
  });

  it("returns null when no provider has a match", async () => {
    const { mock } = mockFetch((url) =>
      url.includes("openlibrary.org") ? json({}) : json({ totalItems: 0 }),
    );

    const client = createCatalogClient({ fetchImpl: mock });
    await expect(client.lookupByIsbn(ISBN13)).resolves.toBeNull();
  });

  it("treats a title-less Open Library record as a miss", async () => {
    const { mock } = mockFetch((url) =>
      url.includes("openlibrary.org")
        ? json({ [`ISBN:${ISBN13}`]: { title: "" } })
        : json({ totalItems: 0 }),
    );

    const client = createCatalogClient({ fetchImpl: mock });
    await expect(client.lookupByIsbn(ISBN13)).resolves.toBeNull();
  });

  it("still falls back to Google Books when Open Library errors", async () => {
    const { mock } = mockFetch((url) =>
      url.includes("openlibrary.org")
        ? json({ error: "nope" }, 503)
        : json({
            totalItems: 1,
            items: [{ volumeInfo: { title: "Fallback", authors: [] } }],
          }),
    );

    const client = createCatalogClient({ fetchImpl: mock });
    await expect(client.lookupByIsbn(ISBN13)).resolves.toMatchObject({
      title: "Fallback",
      authors: [],
      publisher: null,
      publishedYear: null,
      source: "google-books",
    });
  });

  it("throws CatalogError when every provider errors", async () => {
    const { mock } = mockFetch(() => {
      throw new Error("network down");
    });

    const client = createCatalogClient({ fetchImpl: mock });
    await expect(client.lookupByIsbn(ISBN13)).rejects.toBeInstanceOf(CatalogError);
  });

  it("throws CatalogError when every provider returns a non-2xx status", async () => {
    const { mock } = mockFetch(() => json({}, 500));

    const client = createCatalogClient({ fetchImpl: mock });
    await expect(client.lookupByIsbn(ISBN13)).rejects.toBeInstanceOf(CatalogError);
  });

  it("treats a rate-limited (429) Google Books response as a soft miss", async () => {
    const { mock } = mockFetch((url) =>
      url.includes("openlibrary.org") ? json({}) : json({}, 429),
    );

    const client = createCatalogClient({ fetchImpl: mock });
    await expect(client.lookupByIsbn(ISBN13)).resolves.toBeNull();
  });

  it("does not treat a Google Books 429 as a hard failure when Open Library errors", async () => {
    const { mock } = mockFetch((url) =>
      url.includes("openlibrary.org") ? json({}, 503) : json({}, 429),
    );

    const client = createCatalogClient({ fetchImpl: mock });
    await expect(client.lookupByIsbn(ISBN13)).resolves.toBeNull();
  });
});

describe("searchEditions", () => {
  it("maps an Open Library search hit into candidate editions", async () => {
    const { mock, urls } = mockFetch(() =>
      json({
        docs: [
          {
            title: "The C Programming Language",
            author_name: ["Brian W. Kernighan", "Dennis M. Ritchie"],
            publisher: ["Prentice Hall"],
            first_publish_year: 1978,
            isbn_13: [ISBN13],
          },
        ],
      }),
    );

    const client = createCatalogClient({ fetchImpl: mock });

    await expect(
      client.searchEditions({ title: "The C Programming Language" }),
    ).resolves.toEqual([
      {
        title: "The C Programming Language",
        authors: ["Brian W. Kernighan", "Dennis M. Ritchie"],
        publisher: "Prentice Hall",
        publishedYear: 1978,
        isbn13: ISBN13,
        isbn10: null,
        source: "openlibrary",
      },
    ]);
    expect(urls[0]).toContain("search.json");
    expect(urls[0]).toContain("title=The+C+Programming+Language");
    expect(urls.some((url) => url.includes("googleapis.com"))).toBe(false);
  });

  it("synthesizes an ISBN-13 when Open Library only lists an ISBN-10", async () => {
    const { mock } = mockFetch(() =>
      json({ docs: [{ title: "Old Edition", isbn_10: ["0306406152"] }] }),
    );

    const client = createCatalogClient({ fetchImpl: mock });
    await expect(
      client.searchEditions({ title: "Old Edition" }),
    ).resolves.toMatchObject([{ isbn13: ISBN13, isbn10: "0306406152" }]);
  });

  it("passes the author to the Open Library search API", async () => {
    const { mock, urls } = mockFetch(() => json({ docs: [] }));

    const client = createCatalogClient({ fetchImpl: mock });
    await client.searchEditions({ title: "Dune", author: "Frank Herbert" });

    expect(urls[0]).toContain("author=Frank+Herbert");
  });

  it("falls back to Google Books when Open Library search has no docs", async () => {
    const { mock, urls } = mockFetch((url) =>
      url.includes("openlibrary.org")
        ? json({ docs: [] })
        : json({
            totalItems: 1,
            items: [
              {
                volumeInfo: {
                  title: "Google Book",
                  authors: ["Google Author"],
                  publisher: "G Books",
                  publishedDate: "2001-05-01",
                  industryIdentifiers: [
                    { type: "ISBN_13", identifier: ISBN13 },
                  ],
                },
              },
            ],
          }),
    );

    const client = createCatalogClient({ fetchImpl: mock });

    await expect(client.searchEditions({ title: "Some Book" })).resolves.toEqual([
      {
        title: "Google Book",
        authors: ["Google Author"],
        publisher: "G Books",
        publishedYear: 2001,
        isbn13: ISBN13,
        isbn10: null,
        source: "google-books",
      },
    ]);
    const googleUrl = urls.find((url) => url.includes("googleapis.com"));
    expect(decodeURIComponent(googleUrl as string)).toContain("intitle:Some Book");
    expect(googleUrl).toContain("maxResults=10");
  });

  it("retries Google Books with a plain query when the refined intitle: search misses", async () => {
    const { mock, urls } = mockFetch((url) => {
      if (url.includes("openlibrary.org")) return json({ docs: [] });
      if (decodeURIComponent(url).includes("intitle:")) return json({ totalItems: 0 });
      return json({
        totalItems: 1,
        items: [{ volumeInfo: { title: "Plain Hit", authors: [] } }],
      });
    });

    const client = createCatalogClient({ fetchImpl: mock });
    await expect(
      client.searchEditions({ title: "Hyphen-ated" }),
    ).resolves.toMatchObject([{ title: "Plain Hit", source: "google-books" }]);
    const googleCalls = urls.filter((url) => url.includes("googleapis.com"));
    expect(googleCalls).toHaveLength(2);
  });

  it("includes the author in the refined Google Books query", async () => {
    const { mock, urls } = mockFetch((url) =>
      url.includes("openlibrary.org") ? json({ docs: [] }) : json({ totalItems: 0 }),
    );

    const client = createCatalogClient({ fetchImpl: mock });
    await client.searchEditions({ title: "Dune", author: "Frank Herbert" });

    const googleUrl = urls.find((url) => url.includes("googleapis.com"));
    expect(decodeURIComponent(googleUrl as string)).toContain(
      "intitle:Dune inauthor:Frank Herbert",
    );
  });

  it("returns an empty list when neither provider matches", async () => {
    const { mock } = mockFetch((url) =>
      url.includes("openlibrary.org") ? json({ docs: [] }) : json({ totalItems: 0 }),
    );

    const client = createCatalogClient({ fetchImpl: mock });
    await expect(client.searchEditions({ title: "Nonexistent" })).resolves.toEqual([]);
  });

  it("treats a rate-limited (429) Google Books response as an empty result", async () => {
    const { mock } = mockFetch((url) =>
      url.includes("openlibrary.org") ? json({ docs: [] }) : json({}, 429),
    );

    const client = createCatalogClient({ fetchImpl: mock });
    await expect(client.searchEditions({ title: "Rate Limited" })).resolves.toEqual([]);
  });

  it("throws CatalogError when every provider errors", async () => {
    const { mock } = mockFetch(() => {
      throw new Error("network down");
    });

    const client = createCatalogClient({ fetchImpl: mock });
    await expect(
      client.searchEditions({ title: "Anything" }),
    ).rejects.toBeInstanceOf(CatalogError);
  });

  it("short-circuits a blank title without calling any provider", async () => {
    const { mock, urls } = mockFetch(() => json({ docs: [] }));

    const client = createCatalogClient({ fetchImpl: mock });
    await expect(client.searchEditions({ title: "   " })).resolves.toEqual([]);
    expect(urls).toHaveLength(0);
  });
});
