import { describe, expect, it } from "vitest";
import type { SaveableBook } from "@repo/book-schemas";
import {
  addLocalShelfBook,
  LOCAL_SHELF_STORAGE_KEY,
  readLocalShelf,
  type LocalShelfStorage,
} from "../lib/local-shelf";

/** In-memory `localStorage` double recording everything written. */
function createStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const storage: LocalShelfStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
  return { storage, store };
}

const BOOK: SaveableBook = {
  isbn13: "manual:dune-abc123",
  title: "Dune",
  authors: ["Frank Herbert"],
  publisher: null,
  publishedYear: null,
  summary: null,
  source: "manual",
  verified: false,
  enriched: false,
  confidence: "low",
};

describe("readLocalShelf", () => {
  it("returns an empty list when nothing was stored", () => {
    const { storage } = createStorage();
    expect(readLocalShelf(storage)).toEqual([]);
  });

  it("tolerates corrupt JSON and non-array payloads", () => {
    const corrupt = createStorage({ [LOCAL_SHELF_STORAGE_KEY]: "not json" });
    expect(readLocalShelf(corrupt.storage)).toEqual([]);

    const object = createStorage({ [LOCAL_SHELF_STORAGE_KEY]: '{"a":1}' });
    expect(readLocalShelf(object.storage)).toEqual([]);
  });

  it("drops entries that do not carry a titled book", () => {
    const raw = JSON.stringify([
      { book: { title: "Kept" }, addedAt: "2026-01-01T00:00:00.000Z" },
      { book: { authors: ["no title"] } },
      "garbage",
      null,
    ]);
    const { storage } = createStorage({ [LOCAL_SHELF_STORAGE_KEY]: raw });

    const entries = readLocalShelf(storage);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.book.title).toBe("Kept");
    expect(entries[0]?.addedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("defaults a missing addedAt to the epoch", () => {
    const raw = JSON.stringify([{ book: { title: "Kept" } }]);
    const { storage } = createStorage({ [LOCAL_SHELF_STORAGE_KEY]: raw });
    expect(readLocalShelf(storage)[0]?.addedAt).toBe(new Date(0).toISOString());
  });
});

describe("addLocalShelfBook", () => {
  it("appends a book and persists the updated list", () => {
    const { storage, store } = createStorage();

    const entries = addLocalShelfBook(storage, BOOK, "2026-01-01T00:00:00.000Z");

    expect(entries).toHaveLength(1);
    expect(entries[0]?.book.title).toBe("Dune");
    const persisted = JSON.parse(store.get(LOCAL_SHELF_STORAGE_KEY) ?? "[]");
    expect(persisted).toHaveLength(1);
  });

  it("still returns the in-memory list when storage refuses the write", () => {
    // A full/blocked storage (e.g. private mode) must not break the save flow.
    const storage: LocalShelfStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };

    const entries = addLocalShelfBook(storage, BOOK, "2026-01-01T00:00:00.000Z");
    expect(entries).toHaveLength(1);
  });
});
