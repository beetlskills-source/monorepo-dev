import { describe, expect, it } from "vitest";
import type { CatalogBook } from "@repo/book-schemas";
import {
  createFeatherlessClient,
  DEFAULT_FEATHERLESS_VISION_MODEL,
  DEFAULT_TIMEOUT_MS,
  UpstreamError,
  type BatchEnrichmentInput,
} from "../lib/featherless";

const BOOK: CatalogBook = {
  isbn13: "9780241485927",
  title: "Rocks and Minerals",
  authors: ["Unknown"],
  publisher: "Dorling Kindersley",
  publishedYear: 2020,
  source: "openlibrary",
  verified: true,
};

function successResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A `fetch` that answers only after `delayMs`, like a slow large model. */
function slowFetch(delayMs: number, content: string): typeof fetch {
  return ((_input: RequestInfo | URL, _init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      setTimeout(() => resolve(successResponse(content)), delayMs);
    })) as unknown as typeof fetch;
}

/** A `fetch` that never settles until its request `signal` is aborted. */
const hangingFetch = ((
  _input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new Error("The operation was aborted.")),
    );
  })) as unknown as typeof fetch;

describe("Featherless enrichment timeout budget", () => {
  it("keeps the default budget well above 10s so slow model answers are not aborted", () => {
    // Regression: a 10s budget aborted the enrichment request, the route's
    // graceful-degradation catch swallowed the abort, and every lookup came
    // back as `enriched: false` even though enrichment was configured.
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(10_000);
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
  });

  it("returns enrichment when the model answers slowly but within budget", async () => {
    const client = createFeatherlessClient({
      apiKey: "test-key",
      fetchImpl: slowFetch(30, JSON.stringify({ summary: "Slow but fine." })),
      timeoutMs: 5_000,
    });

    await expect(client.enrichBook(BOOK)).resolves.toEqual({
      summary: "Slow but fine.",
    });
  });

  it("raises UpstreamError when the model exceeds the budget", async () => {
    const client = createFeatherlessClient({
      apiKey: "test-key",
      fetchImpl: hangingFetch,
      timeoutMs: 20,
    });

    await expect(client.enrichBook(BOOK)).rejects.toBeInstanceOf(UpstreamError);
  });
});

function batchBook(key: string): BatchEnrichmentInput {
  return {
    key,
    isbn13: "9780241485927",
    title: "Rocks and Minerals",
    authors: ["Unknown"],
  };
}

/** A `fetch` that records request bodies and returns canned content. */
function recordingFetch(content: string) {
  const bodies: string[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return successResponse(content);
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

describe("Featherless batch enrichment (enrichBooks)", () => {
  it("skips the upstream call entirely for an empty batch", async () => {
    let called = false;
    const client = createFeatherlessClient({
      apiKey: "test-key",
      fetchImpl: (async () => {
        called = true;
        return successResponse("{}");
      }) as unknown as typeof fetch,
    });

    await expect(client.enrichBooks([])).resolves.toEqual(new Map());
    expect(called).toBe(false);
  });

  it("maps a summaries list into a key → summary map", async () => {
    const client = createFeatherlessClient({
      apiKey: "test-key",
      fetchImpl: (async () =>
        successResponse(
          JSON.stringify({
            summaries: [
              { key: "2", summary: "First summary." },
              { key: "5", summary: "Second summary." },
            ],
          }),
        )) as unknown as typeof fetch,
    });

    const result = await client.enrichBooks([batchBook("2"), batchBook("5")]);
    expect([...result.entries()]).toEqual([
      ["2", "First summary."],
      ["5", "Second summary."],
    ]);
  });

  it("sends every book key in a single request", async () => {
    const { fetchImpl, bodies } = recordingFetch(
      JSON.stringify({ summaries: [{ key: "2", summary: "S." }] }),
    );
    const client = createFeatherlessClient({ apiKey: "test-key", fetchImpl });

    await client.enrichBooks([batchBook("2"), batchBook("3")]);

    expect(bodies).toHaveLength(1);
    // Both keys ride along in the single user message; the raw body escapes the
    // inner JSON, so inspect the decoded message content instead.
    const body = JSON.parse(bodies[0] ?? "{}");
    const userContent = String(body.messages?.[1]?.content ?? "");
    expect(userContent).toContain('"key":"2"');
    expect(userContent).toContain('"key":"3"');
  });

  it("skips blank keys and blank/null summaries without discarding the batch", async () => {
    const client = createFeatherlessClient({
      apiKey: "test-key",
      fetchImpl: (async () =>
        successResponse(
          JSON.stringify({
            summaries: [
              { key: "2", summary: "  Kept.  " },
              { key: "", summary: "no key" },
              { key: "3", summary: "" },
              { key: "4", summary: null },
              { key: "5", summary: "Also kept." },
            ],
          }),
        )) as unknown as typeof fetch,
    });

    const result = await client.enrichBooks([batchBook("2"), batchBook("5")]);
    expect([...result.entries()]).toEqual([
      ["2", "Kept."],
      ["5", "Also kept."],
    ]);
  });

  it("raises UpstreamError when the summaries list is missing", async () => {
    const client = createFeatherlessClient({
      apiKey: "test-key",
      fetchImpl: (async () =>
        successResponse(JSON.stringify({ books: [] }))) as unknown as typeof fetch,
    });

    await expect(client.enrichBooks([batchBook("2")])).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it("parses markdown-fenced batch JSON", async () => {
    const client = createFeatherlessClient({
      apiKey: "test-key",
      fetchImpl: (async () =>
        successResponse(
          "```json\n" +
            JSON.stringify({ summaries: [{ key: "2", summary: "Fenced." }] }) +
            "\n```",
        )) as unknown as typeof fetch,
    });

    const result = await client.enrichBooks([batchBook("2")]);
    expect(result.get("2")).toBe("Fenced.");
  });
});

const COVER_DATA_URL = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

describe("Featherless vision cover extraction (extractCover)", () => {
  it("sends a multimodal message with the image and the configured vision model", async () => {
    const { fetchImpl, bodies } = recordingFetch(
      JSON.stringify({
        title: "The $100 Startup",
        subtitle: null,
        authors: ["Chris Guillebeau"],
        publisher: null,
      }),
    );
    const client = createFeatherlessClient({
      apiKey: "test-key",
      model: DEFAULT_FEATHERLESS_VISION_MODEL,
      fetchImpl,
    });

    await client.extractCover(COVER_DATA_URL);

    const body = JSON.parse(bodies[0] ?? "{}");
    expect(body.model).toBe(DEFAULT_FEATHERLESS_VISION_MODEL);
    const userContent = body.messages?.[1]?.content;
    expect(Array.isArray(userContent)).toBe(true);
    expect(userContent[0]?.type).toBe("text");
    expect(userContent[1]).toEqual({
      type: "image_url",
      image_url: { url: COVER_DATA_URL },
    });
  });

  it("returns a clean single-clause title from a multi-line display title", async () => {
    const client = createFeatherlessClient({
      apiKey: "test-key",
      fetchImpl: (async () =>
        successResponse(
          JSON.stringify({
            // The model may echo a newline; it must collapse to one clause.
            title: "The $100\nStartup",
            subtitle: "  ",
            authors: ["Chris Guillebeau", "  "],
            publisher: "Crown Business",
            isbn: " 978-0-307-95152-6 ",
          }),
        )) as unknown as typeof fetch,
    });

    await expect(client.extractCover(COVER_DATA_URL)).resolves.toEqual({
      title: "The $100 Startup",
      subtitle: null,
      authors: ["Chris Guillebeau"],
      publisher: "Crown Business",
      isbn: "978-0-307-95152-6",
    });
  });

  it("keeps a Chinese title intact and prefers null/[] over guessing", async () => {
    const client = createFeatherlessClient({
      apiKey: "test-key",
      fetchImpl: (async () =>
        successResponse(
          JSON.stringify({
            title: "紅樓夢",
            subtitle: null,
            authors: [],
            publisher: null,
            isbn: null,
          }),
        )) as unknown as typeof fetch,
    });

    await expect(client.extractCover(COVER_DATA_URL)).resolves.toEqual({
      title: "紅樓夢",
      subtitle: null,
      authors: [],
      publisher: null,
      isbn: null,
    });
  });

  it("defaults a missing isbn hint to null", async () => {
    const client = createFeatherlessClient({
      apiKey: "test-key",
      fetchImpl: (async () =>
        successResponse(
          JSON.stringify({
            title: "Rocks & Minerals",
            subtitle: null,
            authors: [],
            publisher: null,
          }),
        )) as unknown as typeof fetch,
    });

    await expect(client.extractCover(COVER_DATA_URL)).resolves.toMatchObject({
      isbn: null,
    });
  });

  it("parses markdown-fenced vision JSON", async () => {
    const client = createFeatherlessClient({
      apiKey: "test-key",
      fetchImpl: (async () =>
        successResponse(
          "```json\n" +
            JSON.stringify({
              title: "Rocks & Minerals",
              subtitle: null,
              authors: [],
              publisher: null,
            }) +
            "\n```",
        )) as unknown as typeof fetch,
    });

    await expect(client.extractCover(COVER_DATA_URL)).resolves.toMatchObject({
      title: "Rocks & Minerals",
    });
  });

  it("raises UpstreamError when the model returns no usable title", async () => {
    const client = createFeatherlessClient({
      apiKey: "test-key",
      fetchImpl: (async () =>
        successResponse(
          JSON.stringify({ title: "", subtitle: null, authors: [], publisher: null }),
        )) as unknown as typeof fetch,
    });

    await expect(client.extractCover(COVER_DATA_URL)).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it("raises UpstreamError on a non-2xx vision response", async () => {
    const client = createFeatherlessClient({
      apiKey: "test-key",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });

    await expect(client.extractCover(COVER_DATA_URL)).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });
});
