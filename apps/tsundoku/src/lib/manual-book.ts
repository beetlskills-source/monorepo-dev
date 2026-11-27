/**
 * Pure helpers for the "Read Book Title" / no-ISBN fallback. When a book has
 * no catalogue match (and therefore no ISBN), the user-confirmed title and
 * author are mapped into the same {@link SaveableBook} shape the catalog path
 * produces, with a synthetic internal id in place of the ISBN. Kept free of
 * DOM/Worker APIs so it is deterministic and unit-testable.
 */

import type { SaveableBook } from "@repo/book-schemas";

/** Separator used to flatten the `authors` array in the sheet, mirrored here. */
const AUTHOR_SEPARATOR = ", ";

/** URL/sheet-safe prefix marking an id that is explicitly not a real ISBN. */
export const MANUAL_ID_PREFIX = "manual:";

/** FNV-1a (32-bit) hash, rendered as unpadded hex, for a stable short digest. */
function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    result ^= value.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in integer range.
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16);
}

/**
 * Deterministic synthetic id for an uncataloged book. The slug keeps the id
 * human-readable in the sheet; the hash suffix keeps two books that share a
 * title (different authors) from colliding.
 */
export function createLocalBookId(title: string, author = ""): string {
  const normalized = `${title} ${author}`.trim().toLowerCase();
  const slug = normalized
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const digest = hash(normalized);
  return `${MANUAL_ID_PREFIX}${slug === "" ? "book" : slug}-${digest}`;
}

/** Split a free-text author string into a clean, de-duplicated list. */
export function parseAuthors(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split(/[;,]/)
    .map((author) => author.trim())
    .filter((author) => author !== "");
}

export interface ManualBookInput {
  title: string;
  /** Free-text author(s); split on commas/semicolons. Ignored if `authors`. */
  author?: string | null;
  /** Pre-split author list, taking precedence over {@link author}. */
  authors?: string[];
  publisher?: string | null;
  publishedYear?: number | null;
  /** A real ISBN when the user picked a catalogue edition; else synthetic. */
  isbn13?: string | null;
}

/**
 * Map a user-confirmed, uncataloged book into a {@link SaveableBook} so it can
 * be persisted through the exact same save path as a catalogue hit. Marked
 * `source: "manual"`, `verified: false`, `confidence: "low"` — it was never
 * corroborated by a catalogue — and given a synthetic id when no ISBN exists.
 */
export function buildManualBook(input: ManualBookInput): SaveableBook {
  const title = input.title.trim();
  const authors =
    input.authors && input.authors.length > 0
      ? input.authors.map((author) => author.trim()).filter((a) => a !== "")
      : parseAuthors(input.author);
  const isbn13 = input.isbn13?.trim() ?? "";

  return {
    isbn13:
      isbn13 !== ""
        ? isbn13
        : createLocalBookId(title, authors.join(AUTHOR_SEPARATOR)),
    title,
    authors,
    publisher: input.publisher ?? null,
    publishedYear: input.publishedYear ?? null,
    summary: null,
    source: "manual",
    verified: false,
    enriched: false,
    confidence: "low",
  };
}
