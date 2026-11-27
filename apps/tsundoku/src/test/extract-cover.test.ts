import { describe, expect, it, vi } from "vitest";
import type { APIContext } from "astro";
import type { CatalogClient } from "../lib/catalog";
import { DEFAULT_FEATHERLESS_VISION_MODEL } from "../lib/featherless";

/**
 * `cloudflare:workers` only exists on the Workers runtime; stub it so the route
 * module can be imported in Node. The handler reads no globals here — every
 * dependency is injected per test.
 */
vi.mock("cloudflare:workers", () => ({ env: {} }));

const { handleExtractCover, parseCoverDataUrl, MAX_COVER_IMAGE_BYTES } =
  await import("../pages/api/books/extract-cover");

type CoverContext = Pick<APIContext, "request">;

function makeContext(body: string | Record<string, unknown>): CoverContext {
  const request = new Request("https://tsundoku.test/api/books/extract-cover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { request };
}

/** A tiny, well-formed JPEG data URL (decodes to ~10 bytes). */
const SOLID_JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

/** A base64 JPEG data URL whose decoded size exceeds {@link MAX_COVER_IMAGE_BYTES}. */
function oversizedJpegDataUrl(): string {
  const base64 = "A".repeat(Math.ceil(MAX_COVER_IMAGE_BYTES / 3) * 4 + 4);
  return `data:image/jpeg;base64,${base64}`;
}

const PAID = { userId: "u1", hasLlmUnlock: true, apiKey: "test-key" } as const;

/** An OpenAI-compatible vision response carrying `content` as the message. */
function visionResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const EXTRACTION = {
  title: "The $100 Startup",
  subtitle: null,
  authors: ["Chris Guillebeau"],
  publisher: "Crown Business",
  isbn: null,
};

/** Resolved response when the vision hints stand alone (no catalog injected). */
const VISION_ONLY = {
  ...EXTRACTION,
  publishedYear: null,
  summary: null,
  enriched: false,
  source: "vision_only",
  provider: null,
  confidence: "low",
  candidates: [],
} as const;

/** Build a catalog stub; individual methods are overridden per test. */
function stubCatalog(overrides: Partial<CatalogClient>): CatalogClient {
  return {
    lookupByIsbn: async () => null,
    searchEditions: async () => [],
    ...overrides,
  };
}

describe("parseCoverDataUrl", () => {
  it("reports the MIME type and decoded byte length", () => {
    expect(parseCoverDataUrl(SOLID_JPEG)).toEqual({ mime: "image/jpeg", bytes: 10 });
  });

  it("returns null for a non-data URL", () => {
    expect(parseCoverDataUrl("/9j/4AAQSkZJRg==")).toBeNull();
    expect(parseCoverDataUrl("data:image/jpeg,not-base64")).toBeNull();
  });
});

describe("handleExtractCover — three-tier entitlement", () => {
  it("returns 401 for an anonymous caller and never reaches Featherless", async () => {
    const fetchImpl = vi.fn();
    const response = await handleExtractCover(makeContext({ image: SOLID_JPEG }), {
      userId: null,
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: "UNAUTHENTICATED",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns 403 LLM_LOCKED for a signed-in user without the unlock", async () => {
    const fetchImpl = vi.fn();
    const response = await handleExtractCover(makeContext({ image: SOLID_JPEG }), {
      userId: "u1",
      hasLlmUnlock: false,
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "LLM_LOCKED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("handleExtractCover — request validation", () => {
  it("returns 400 for a malformed JSON body", async () => {
    const response = await handleExtractCover(makeContext("not-json"), PAID);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "INVALID_REQUEST",
    });
  });

  it("returns 400 when the image field is missing", async () => {
    const response = await handleExtractCover(makeContext({}), PAID);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "INVALID_REQUEST",
    });
  });

  it("returns 400 for a non-JPEG/WebP data URL", async () => {
    const response = await handleExtractCover(
      makeContext({ image: "data:image/png;base64,iVBORw0KGgo=" }),
      PAID,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "INVALID_REQUEST",
    });
  });

  it("returns 400 for a raw (non-data-URL) base64 string", async () => {
    const response = await handleExtractCover(
      makeContext({ image: "/9j/4AAQSkZJRg==" }),
      PAID,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "INVALID_REQUEST",
    });
  });

  it("returns 413 when the decoded image exceeds the size limit", async () => {
    const response = await handleExtractCover(
      makeContext({ image: oversizedJpegDataUrl() }),
      PAID,
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: "PAYLOAD_TOO_LARGE",
    });
  });

  it("returns 503 when the vision model is not configured", async () => {
    const response = await handleExtractCover(makeContext({ image: SOLID_JPEG }), {
      userId: "u1",
      hasLlmUnlock: true,
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "CONFIG_ERROR" });
  });
});

describe("handleExtractCover — Paid-Registered success", () => {
  it("returns the strict extraction and defaults to the vision model", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return visionResponse(JSON.stringify(EXTRACTION));
    }) as unknown as typeof fetch;

    const response = await handleExtractCover(makeContext({ image: SOLID_JPEG }), {
      ...PAID,
      fetchImpl,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(VISION_ONLY);

    const body = JSON.parse(bodies[0] ?? "{}");
    expect(body.model).toBe(DEFAULT_FEATHERLESS_VISION_MODEL);
    expect(body.response_format).toEqual({ type: "json_object" });
    // The compressed image rides along as an OpenAI-style multimodal part.
    const userContent = body.messages?.[1]?.content;
    expect(userContent?.[1]).toEqual({
      type: "image_url",
      image_url: { url: SOLID_JPEG },
    });
  });

  it("returns 502 UPSTREAM_ERROR when the vision call fails", async () => {
    const fetchImpl = (async () =>
      visionResponse("boom", 500)) as unknown as typeof fetch;

    const response = await handleExtractCover(makeContext({ image: SOLID_JPEG }), {
      ...PAID,
      fetchImpl,
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: "UPSTREAM_ERROR",
    });
  });
});

describe("handleExtractCover — usage metering", () => {
  it("meters one cover read after a successful extraction", async () => {
    const fetchImpl = (async () =>
      visionResponse(JSON.stringify(EXTRACTION))) as unknown as typeof fetch;
    const chargeUsage = vi.fn(async () => {});

    const response = await handleExtractCover(makeContext({ image: SOLID_JPEG }), {
      ...PAID,
      fetchImpl,
      chargeUsage,
    });

    expect(response.status).toBe(200);
    expect(chargeUsage).toHaveBeenCalledWith(1);
  });

  it("never meters a denied request", async () => {
    const chargeUsage = vi.fn(async () => {});
    const response = await handleExtractCover(makeContext({ image: SOLID_JPEG }), {
      userId: "u1",
      hasLlmUnlock: false,
      apiKey: "test-key",
      chargeUsage,
    });

    expect(response.status).toBe(403);
    expect(chargeUsage).not.toHaveBeenCalled();
  });

  it("still returns the extraction when metering throws", async () => {
    const fetchImpl = (async () =>
      visionResponse(JSON.stringify(EXTRACTION))) as unknown as typeof fetch;
    const chargeUsage = vi.fn(async () => {
      throw new Error("d1 down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await handleExtractCover(
        makeContext({ image: SOLID_JPEG }),
        { ...PAID, fetchImpl, chargeUsage },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(VISION_ONLY);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("handleExtractCover — catalog promotion", () => {
  it("promotes an isbn hint to canonical catalog metadata", async () => {
    const fetchImpl = (async () =>
      visionResponse(
        JSON.stringify({
          ...EXTRACTION,
          authors: [],
          isbn: "978-0-307-95152-6",
        }),
      )) as unknown as typeof fetch;
    const lookupByIsbn = vi.fn(async (isbn13: string) => ({
      isbn13,
      title: "The $100 Startup",
      authors: ["Chris Guillebeau"],
      publisher: "Crown Business",
      publishedYear: 2012,
      source: "openlibrary" as const,
      verified: true as const,
    }));
    const catalog = stubCatalog({ lookupByIsbn });

    const response = await handleExtractCover(makeContext({ image: SOLID_JPEG }), {
      ...PAID,
      fetchImpl,
      catalog,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      title: "The $100 Startup",
      subtitle: null,
      authors: ["Chris Guillebeau"],
      publisher: "Crown Business",
      publishedYear: 2012,
      isbn: "9780307951526",
      summary: null,
      enriched: false,
      source: "catalog_lookup",
      provider: "openlibrary",
      confidence: "high",
      candidates: [
        {
          title: "The $100 Startup",
          authors: ["Chris Guillebeau"],
          publisher: "Crown Business",
          publishedYear: 2012,
          isbn13: "9780307951526",
          isbn10: null,
          source: "openlibrary",
        },
      ],
    });
    // The hint was normalized (hyphens stripped) before the ISBN lookup.
    expect(lookupByIsbn).toHaveBeenCalledWith("9780307951526");
  });

  it("falls back to a title search when no isbn is legible", async () => {
    const fetchImpl = (async () =>
      visionResponse(
        JSON.stringify({
          ...EXTRACTION,
          authors: [],
          publisher: null,
          isbn: null,
        }),
      )) as unknown as typeof fetch;
    const searchEditions = vi.fn(async () => [
      {
        title: "The $100 Startup",
        authors: ["Chris Guillebeau"],
        publisher: "Crown Business",
        publishedYear: 2012,
        isbn13: "9780307951526",
        isbn10: null,
        source: "openlibrary" as const,
      },
    ]);
    const catalog = stubCatalog({ searchEditions });

    const response = await handleExtractCover(makeContext({ image: SOLID_JPEG }), {
      ...PAID,
      fetchImpl,
      catalog,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      title: "The $100 Startup",
      authors: ["Chris Guillebeau"],
      publishedYear: 2012,
      isbn: "9780307951526",
      source: "catalog_lookup",
      provider: "openlibrary",
      confidence: "high",
      // The title-search editions ride along as "Possible Book Titles" rows.
      candidates: [
        {
          title: "The $100 Startup",
          authors: ["Chris Guillebeau"],
          isbn13: "9780307951526",
          isbn10: null,
          source: "openlibrary",
        },
      ],
    });
    expect(searchEditions).toHaveBeenCalledWith({
      title: "The $100 Startup",
      author: undefined,
    });
  });

  it("strips an author possessive prefix and still matches the catalog", async () => {
    const fetchImpl = (async () =>
      visionResponse(
        JSON.stringify({
          ...EXTRACTION,
          title: "Chris Guillebeau's The $100 Startup",
          authors: ["Chris Guillebeau"],
          isbn: null,
        }),
      )) as unknown as typeof fetch;
    const searchEditions = vi.fn(async ({ title }: { title: string }) =>
      title === "The $100 Startup"
        ? [
            {
              title: "The $100 Startup",
              authors: ["Chris Guillebeau"],
              publisher: "Crown Business",
              publishedYear: 2012,
              isbn13: "9780307951526",
              isbn10: null,
              source: "openlibrary" as const,
            },
          ]
        : [],
    );
    const catalog = stubCatalog({ searchEditions });

    const response = await handleExtractCover(makeContext({ image: SOLID_JPEG }), {
      ...PAID,
      fetchImpl,
      catalog,
    });

    expect(response.status).toBe(200);
    // The polluted raw hint is tried first, then the cleaned title matches.
    await expect(response.json()).resolves.toMatchObject({
      title: "The $100 Startup",
      isbn: "9780307951526",
      source: "catalog_lookup",
      provider: "openlibrary",
    });
    expect(searchEditions).toHaveBeenCalledWith({
      title: "The $100 Startup",
      author: "Chris Guillebeau",
    });
  });

  it("returns vision_only when the catalog finds no match", async () => {
    const fetchImpl = (async () =>
      visionResponse(JSON.stringify(EXTRACTION))) as unknown as typeof fetch;

    const response = await handleExtractCover(makeContext({ image: SOLID_JPEG }), {
      ...PAID,
      fetchImpl,
      catalog: stubCatalog({}),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(VISION_ONLY);
  });

  it("degrades to vision_only when the catalog throws", async () => {
    const fetchImpl = (async () =>
      visionResponse(
        JSON.stringify({ ...EXTRACTION, isbn: "9780307951526" }),
      )) as unknown as typeof fetch;
    const catalog = stubCatalog({
      lookupByIsbn: async () => {
        throw new Error("catalog down");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await handleExtractCover(
        makeContext({ image: SOLID_JPEG }),
        { ...PAID, fetchImpl, catalog },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        source: "vision_only",
        authors: ["Chris Guillebeau"],
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("ignores an invalid isbn hint and searches by title instead", async () => {
    const fetchImpl = (async () =>
      visionResponse(
        JSON.stringify({ ...EXTRACTION, isbn: "not-an-isbn" }),
      )) as unknown as typeof fetch;
    const lookupByIsbn = vi.fn(async () => null);
    const searchEditions = vi.fn(async () => []);
    const catalog = stubCatalog({ lookupByIsbn, searchEditions });

    await handleExtractCover(makeContext({ image: SOLID_JPEG }), {
      ...PAID,
      fetchImpl,
      catalog,
    });

    expect(lookupByIsbn).not.toHaveBeenCalled();
    expect(searchEditions).toHaveBeenCalled();
  });
});

describe("handleExtractCover — single-pass enrichment", () => {
  const CATALOG_BOOK = {
    title: "The $100 Startup",
    authors: ["Chris Guillebeau"],
    publisher: "Crown Business",
    publishedYear: 2012,
    source: "openlibrary" as const,
    verified: true as const,
  };

  function matchedCatalog() {
    return stubCatalog({
      lookupByIsbn: vi.fn(async (isbn13: string) => ({
        ...CATALOG_BOOK,
        isbn13,
      })),
    });
  }

  /** First call returns the vision hint; subsequent calls return `extra`. */
  function sequencedFetch(extra: () => Response): typeof fetch {
    let call = 0;
    return (async () => {
      call += 1;
      return call === 1
        ? visionResponse(
            JSON.stringify({ ...EXTRACTION, authors: [], isbn: "9780307951526" }),
          )
        : extra();
    }) as unknown as typeof fetch;
  }

  it("folds the LLM summary into the same pass when enrichment is on", async () => {
    const fetchImpl = sequencedFetch(() =>
      visionResponse(JSON.stringify({ summary: "A short summary." })),
    );
    const chargeSummary = vi.fn(async () => {});

    const response = await handleExtractCover(makeContext({ image: SOLID_JPEG }), {
      ...PAID,
      fetchImpl,
      catalog: matchedCatalog(),
      enrich: true,
      chargeSummary,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      source: "catalog_lookup",
      provider: "openlibrary",
      summary: "A short summary.",
      enriched: true,
    });
    expect(chargeSummary).toHaveBeenCalledWith(1);
  });

  it("skips enrichment when the caller has not opted in", async () => {
    const extra = vi.fn(() =>
      visionResponse(JSON.stringify({ summary: "A short summary." })),
    );
    const chargeSummary = vi.fn(async () => {});

    const response = await handleExtractCover(makeContext({ image: SOLID_JPEG }), {
      ...PAID,
      fetchImpl: sequencedFetch(extra),
      catalog: matchedCatalog(),
      chargeSummary,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      summary: null,
      enriched: false,
    });
    expect(extra).not.toHaveBeenCalled();
    expect(chargeSummary).not.toHaveBeenCalled();
  });

  it("degrades to enriched:false when enrichment fails", async () => {
    const fetchImpl = sequencedFetch(() => visionResponse("boom", 500));
    const chargeSummary = vi.fn(async () => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await handleExtractCover(
        makeContext({ image: SOLID_JPEG }),
        {
          ...PAID,
          fetchImpl,
          catalog: matchedCatalog(),
          enrich: true,
          chargeSummary,
        },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        source: "catalog_lookup",
        summary: null,
        enriched: false,
      });
      expect(chargeSummary).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
