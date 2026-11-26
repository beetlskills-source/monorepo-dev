import { describe, expect, it } from "vitest";
import {
  DUPLICATE_ISBN_COOLDOWN_MS,
  extractIsbnCandidates,
  isDuplicateScan,
  isVideoStalled,
} from "../lib/scanner";

const VALID_ISBN13 = "9780306406157";
const VALID_ISBN10 = "0306406152";

describe("extractIsbnCandidates", () => {
  it("extracts a bare ISBN-13", () => {
    expect(extractIsbnCandidates(VALID_ISBN13)).toEqual([VALID_ISBN13]);
  });

  it("normalizes hyphens and spaces", () => {
    expect(extractIsbnCandidates("978-0-306-40615-7")).toEqual([VALID_ISBN13]);
    expect(extractIsbnCandidates("978 0 306 40615 7")).toEqual([VALID_ISBN13]);
  });

  it("converts a valid ISBN-10 into its ISBN-13 candidate", () => {
    expect(extractIsbnCandidates(VALID_ISBN10)).toEqual([VALID_ISBN13]);
    expect(extractIsbnCandidates("0-306-40615-2")).toEqual([VALID_ISBN13]);
  });

  it("converts an ISBN-10 with an X check digit", () => {
    expect(extractIsbnCandidates("123456789X")).toEqual(["9781234567897"]);
  });

  it("finds an ISBN embedded in noisy barcode text", () => {
    expect(extractIsbnCandidates(`EAN ${VALID_ISBN13} extra`)).toContain(
      VALID_ISBN13,
    );
  });

  it("de-duplicates repeated candidates", () => {
    expect(extractIsbnCandidates(`${VALID_ISBN13} ${VALID_ISBN13}`)).toEqual([
      VALID_ISBN13,
    ]);
  });

  it("ignores non-book EAN-13 barcodes", () => {
    // A valid EAN-13 check digit but without a 978/979 ISBN prefix.
    expect(extractIsbnCandidates("4006381333931")).toEqual([]);
  });

  it("ignores an ISBN-shaped value with a bad check digit", () => {
    expect(extractIsbnCandidates("9780306406158")).toEqual([]);
  });

  it("ignores QR codes, URLs, and arbitrary text without throwing", () => {
    expect(() => extractIsbnCandidates("https://example.com/not-a-book")).not.toThrow();
    expect(extractIsbnCandidates("https://example.com/not-a-book")).toEqual([]);
    expect(extractIsbnCandidates("")).toEqual([]);
    expect(extractIsbnCandidates("HELLO WORLD")).toEqual([]);
  });
});

describe("isDuplicateScan", () => {
  it("flags the same ISBN inside the cooldown window", () => {
    const previous = { isbn: VALID_ISBN13, at: 1000 };
    expect(isDuplicateScan(previous, VALID_ISBN13, 1600)).toBe(true);
  });

  it("allows the same ISBN once the cooldown has elapsed", () => {
    const previous = { isbn: VALID_ISBN13, at: 1000 };
    expect(
      isDuplicateScan(previous, VALID_ISBN13, 1000 + DUPLICATE_ISBN_COOLDOWN_MS),
    ).toBe(false);
  });

  it("allows a different ISBN immediately", () => {
    const previous = { isbn: VALID_ISBN13, at: 1000 };
    expect(isDuplicateScan(previous, "9781234567897", 1000)).toBe(false);
  });

  it("allows the first scan when nothing was recorded", () => {
    expect(isDuplicateScan(null, VALID_ISBN13, 1000)).toBe(false);
  });

  it("honors a custom cooldown", () => {
    const previous = { isbn: VALID_ISBN13, at: 1000 };
    expect(isDuplicateScan(previous, VALID_ISBN13, 1500, 1000)).toBe(true);
    expect(isDuplicateScan(previous, VALID_ISBN13, 2000, 1000)).toBe(false);
  });
});

describe("isVideoStalled", () => {
  it("reports a stall when metadata is not ready", () => {
    expect(isVideoStalled(null, { readyState: 1, currentTime: 0 })).toBe(true);
  });

  it("does not report a stall on the first ready sample", () => {
    expect(isVideoStalled(null, { readyState: 2, currentTime: 5 })).toBe(false);
  });

  it("reports a stall when currentTime stops advancing", () => {
    expect(
      isVideoStalled(
        { readyState: 4, currentTime: 5 },
        { readyState: 4, currentTime: 5 },
      ),
    ).toBe(true);
  });

  it("does not report a stall while the clock advances", () => {
    expect(
      isVideoStalled(
        { readyState: 4, currentTime: 5 },
        { readyState: 4, currentTime: 6 },
      ),
    ).toBe(false);
  });
});
