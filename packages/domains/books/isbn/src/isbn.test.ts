import { describe, expect, it } from "vitest";
import {
  Isbn13Schema,
  isbn10ToIsbn13,
  isValidIsbn10,
  isValidIsbn13,
  normalizeIsbn,
  toIsbn13,
} from "./index";

const VALID_ISBN13 = "9780306406157";
const VALID_ISBN10 = "0306406152";

describe("normalizeIsbn", () => {
  it("strips hyphens and spaces and uppercases the check digit", () => {
    expect(normalizeIsbn("978-0-306-40615-7")).toBe(VALID_ISBN13);
    expect(normalizeIsbn("0 306 40615 2")).toBe(VALID_ISBN10);
    expect(normalizeIsbn("123456789x")).toBe("123456789X");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeIsbn("  9780306406157  ")).toBe(VALID_ISBN13);
  });
});

describe("isValidIsbn13", () => {
  it("accepts a valid ISBN-13", () => {
    expect(isValidIsbn13(VALID_ISBN13)).toBe(true);
  });

  it("rejects a wrong check digit", () => {
    expect(isValidIsbn13("9780306406158")).toBe(false);
  });

  it("rejects the wrong length", () => {
    expect(isValidIsbn13("978030640615")).toBe(false);
  });

  it("rejects a non-book EAN-13 without a 978/979 prefix", () => {
    expect(isValidIsbn13("4006381333931")).toBe(false);
  });
});

describe("isValidIsbn10", () => {
  it("accepts a valid ISBN-10", () => {
    expect(isValidIsbn10(VALID_ISBN10)).toBe(true);
  });

  it("accepts a trailing X check digit", () => {
    expect(isValidIsbn10("123456789X")).toBe(true);
  });

  it("rejects a wrong check digit", () => {
    expect(isValidIsbn10("0306406153")).toBe(false);
  });

  it("rejects the wrong length", () => {
    expect(isValidIsbn10("030640615")).toBe(false);
  });
});

describe("isbn10ToIsbn13", () => {
  it("converts a valid ISBN-10 to ISBN-13", () => {
    expect(isbn10ToIsbn13(VALID_ISBN10)).toBe(VALID_ISBN13);
  });

  it("returns null for an invalid ISBN-10", () => {
    expect(isbn10ToIsbn13("0306406153")).toBeNull();
  });
});

describe("toIsbn13", () => {
  it("passes through a valid ISBN-13", () => {
    expect(toIsbn13(VALID_ISBN13)).toBe(VALID_ISBN13);
  });

  it("normalizes a formatted ISBN-13", () => {
    expect(toIsbn13("978-0-306-40615-7")).toBe(VALID_ISBN13);
  });

  it("converts a formatted ISBN-10", () => {
    expect(toIsbn13("0-306-40615-2")).toBe(VALID_ISBN13);
  });

  it("returns null for non-ISBN input", () => {
    expect(toIsbn13("hello world")).toBeNull();
    expect(toIsbn13("12345")).toBeNull();
  });

  it("returns null for a non-book EAN-13", () => {
    expect(toIsbn13("4006381333931")).toBeNull();
  });
});

describe("Isbn13Schema", () => {
  it("accepts a canonical 13-digit ISBN", () => {
    expect(Isbn13Schema.safeParse(VALID_ISBN13).success).toBe(true);
  });

  it("rejects formatted, short, or long values", () => {
    expect(Isbn13Schema.safeParse("978-0-306-40615-7").success).toBe(false);
    expect(Isbn13Schema.safeParse("978030640615").success).toBe(false);
    expect(Isbn13Schema.safeParse("97803064061578").success).toBe(false);
    expect(Isbn13Schema.safeParse(9780306406157).success).toBe(false);
  });
});
