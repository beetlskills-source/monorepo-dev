/**
 * Stateless, client-only shelf storage for the Free-Unregistered tier. An
 * anonymous visitor has no D1 row and no Google Sheet, so books they look up
 * or save live entirely in `localStorage` — satisfying the "no D1 reads/writes
 * while unregistered" rule. Kept behind a tiny injectable-storage interface so
 * it is unit-testable without a browser.
 */

import type { SaveableBook } from "@repo/book-schemas";

/** `localStorage` key holding the anonymous visitor's book list. */
export const LOCAL_SHELF_STORAGE_KEY = "tsundoku.localShelf";

/** The slice of the Web Storage API this module needs (satisfied by `localStorage`). */
export interface LocalShelfStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LocalShelfEntry {
  book: SaveableBook;
  addedAt: string;
}

/** Read the anonymous shelf, tolerating missing/corrupt storage. */
export function readLocalShelf(storage: LocalShelfStorage): LocalShelfEntry[] {
  let raw: string | null = null;
  try {
    raw = storage.getItem(LOCAL_SHELF_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const book = record.book;
    if (typeof book !== "object" || book === null) return [];
    if (typeof (book as { title?: unknown }).title !== "string") return [];
    return [
      {
        book: book as SaveableBook,
        addedAt:
          typeof record.addedAt === "string"
            ? record.addedAt
            : new Date(0).toISOString(),
      },
    ];
  });
}

/** Append a book to the anonymous shelf and return the updated list. */
export function addLocalShelfBook(
  storage: LocalShelfStorage,
  book: SaveableBook,
  addedAt: string,
): LocalShelfEntry[] {
  const entries = [...readLocalShelf(storage), { book, addedAt }];
  try {
    storage.setItem(LOCAL_SHELF_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // A full/blocked storage must not break the save flow; the in-memory list
    // is still returned so the UI can reflect the added book.
  }
  return entries;
}
