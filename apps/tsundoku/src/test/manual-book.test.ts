import { describe, expect, it } from "vitest";
import { SaveableBookSchema } from "@repo/book-schemas";
import {
  buildManualBook,
  createLocalBookId,
  MANUAL_ID_PREFIX,
  parseAuthors,
} from "../lib/manual-book";

describe("createLocalBookId", () => {
  it("is deterministic, prefixed, and slugged from the title", () => {
    const id = createLocalBookId("The $100 Startup", "Chris Guillebeau");
    expect(id.startsWith(MANUAL_ID_PREFIX)).toBe(true);
    expect(id).toBe(createLocalBookId("The $100 Startup", "Chris Guillebeau"));
    expect(id).toContain("the-100-startup");
  });

  it("does not collide when two books share a title but differ by author", () => {
    expect(createLocalBookId("Dune", "Frank Herbert")).not.toBe(
      createLocalBookId("Dune", "Someone Else"),
    );
  });

  it("keeps CJK characters in the slug", () => {
    expect(createLocalBookId("紅樓夢")).toContain("紅樓夢");
  });

  it("falls back to a generic slug for symbol-only titles", () => {
    expect(createLocalBookId("$ 100 %")).toContain("100");
    expect(createLocalBookId("!!!")).toMatch(/^manual:book-[0-9a-f]+$/);
  });
});

describe("parseAuthors", () => {
  it("splits on commas and semicolons and trims each name", () => {
    expect(parseAuthors("A, B; C")).toEqual(["A", "B", "C"]);
  });

  it("returns an empty list for blank input", () => {
    expect(parseAuthors("")).toEqual([]);
    expect(parseAuthors(null)).toEqual([]);
    expect(parseAuthors(undefined)).toEqual([]);
  });
});

describe("buildManualBook", () => {
  it("maps a user-confirmed book into a saveable manual book with a synthetic id", () => {
    const book = buildManualBook({
      title: "  Uncataloged Journal  ",
      author: "Jane Doe",
    });

    expect(book.title).toBe("Uncataloged Journal");
    expect(book.authors).toEqual(["Jane Doe"]);
    expect(book.source).toBe("manual");
    expect(book.verified).toBe(false);
    expect(book.enriched).toBe(false);
    expect(book.summary).toBeNull();
    expect(book.confidence).toBe("low");
    expect(book.isbn13.startsWith(MANUAL_ID_PREFIX)).toBe(true);
    expect(SaveableBookSchema.safeParse(book).success).toBe(true);
  });

  it("uses a real ISBN when the user picked a catalogue edition", () => {
    const book = buildManualBook({
      title: "Dune",
      authors: ["Frank Herbert"],
      isbn13: "9780441172719",
    });
    expect(book.isbn13).toBe("9780441172719");
  });

  it("prefers a pre-split authors list over the free-text author", () => {
    const book = buildManualBook({
      title: "T",
      author: "Ignored",
      authors: ["A", "B"],
    });
    expect(book.authors).toEqual(["A", "B"]);
  });

  it("treats a blank isbn13 as absent and synthesises an id", () => {
    const book = buildManualBook({ title: "T", isbn13: "   " });
    expect(book.isbn13.startsWith(MANUAL_ID_PREFIX)).toBe(true);
  });
});
