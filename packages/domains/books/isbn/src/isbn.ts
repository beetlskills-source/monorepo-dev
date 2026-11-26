/**
 * Pure ISBN normalization, validation, and ISBN-10 -> ISBN-13 conversion.
 * This module stays dependency-free so it can run in the browser bundle.
 */

/** Strip every non-digit character except a trailing `X` check digit marker. */
export function normalizeIsbn(input: string): string {
  return input.replace(/[^0-9Xx]/g, "").toUpperCase();
}

/** Validate an ISBN-10 string, including its modulo-11 check digit. */
export function isValidIsbn10(input: string): boolean {
  const isbn = normalizeIsbn(input);
  if (!/^\d{9}[\dX]$/.test(isbn)) {
    return false;
  }

  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const text = isbn.slice(i, i + 1);
    const value = text === "X" ? 10 : Number(text);
    sum += value * (10 - i);
  }
  return sum % 11 === 0;
}

/**
 * Validate an ISBN-13 string. Requires the 978/979 "Bookland" EAN prefix so
 * non-book EAN-13 barcodes are rejected, plus a valid modulo-10 check digit.
 */
export function isValidIsbn13(input: string): boolean {
  const isbn = normalizeIsbn(input);
  if (!/^97[89]\d{10}$/.test(isbn)) {
    return false;
  }

  let sum = 0;
  for (let i = 0; i < 13; i += 1) {
    const value = Number(isbn.slice(i, i + 1));
    sum += value * (i % 2 === 0 ? 1 : 3);
  }
  return sum % 10 === 0;
}

/** Compute the ISBN-13 check digit for a 12-digit prefix. */
function isbn13CheckDigit(prefix12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const value = Number(prefix12.slice(i, i + 1));
    sum += value * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

/** Convert a valid ISBN-10 to its ISBN-13 equivalent, or `null` if invalid. */
export function isbn10ToIsbn13(input: string): string | null {
  const isbn = normalizeIsbn(input);
  if (!isValidIsbn10(isbn)) {
    return null;
  }

  const prefix = `978${isbn.slice(0, 9)}`;
  return `${prefix}${isbn13CheckDigit(prefix)}`;
}

/**
 * Normalize any raw/formatted ISBN-10 or ISBN-13 input into a canonical
 * 13-digit ISBN, or return `null` when the value is not a valid ISBN.
 */
export function toIsbn13(input: string): string | null {
  const isbn = normalizeIsbn(input);
  if (isValidIsbn13(isbn)) {
    return isbn;
  }
  return isbn10ToIsbn13(isbn);
}
