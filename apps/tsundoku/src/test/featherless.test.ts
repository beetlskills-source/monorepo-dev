import { describe, expect, it } from "vitest";
import type { CatalogBook } from "@repo/book-schemas";
import {
  createFeatherlessClient,
  DEFAULT_TIMEOUT_MS,
  UpstreamError,
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
