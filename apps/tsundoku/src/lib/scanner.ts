import { toIsbn13 } from "@repo/isbn";

/**
 * Modular barcode/ISBN candidate extraction helpers. Pure functions that run in
 * the browser to turn raw scanner text into normalized ISBN-13 candidates.
 */

const SEPARATORS = /[\s-]/g;
const NON_ISBN_CHARS = /[^0-9Xx]+/g;

/**
 * Extract every valid ISBN-13 candidate found in a raw barcode string.
 * Handles full-string matches, separator-delimited runs, and ISBNs embedded
 * inside longer barcode payloads (e.g. an EAN-13 with surrounding noise).
 */
export function extractIsbnCandidates(raw: string): string[] {
  const compact = raw.trim().replace(SEPARATORS, "");
  const candidates = new Set<string>();

  const whole = toIsbn13(compact);
  if (whole) {
    candidates.add(whole);
  }

  for (const run of compact.split(NON_ISBN_CHARS)) {
    const isbn = toIsbn13(run);
    if (isbn) {
      candidates.add(isbn);
    }
  }

  const digits = compact.replace(NON_ISBN_CHARS, "").toUpperCase();
  for (const length of [13, 10]) {
    for (let i = 0; i + length <= digits.length; i += 1) {
      const isbn = toIsbn13(digits.slice(i, i + length));
      if (isbn) {
        candidates.add(isbn);
      }
    }
  }

  return [...candidates];
}

/** How long the same barcode is ignored after a scan, to avoid re-lookups. */
export const DUPLICATE_ISBN_COOLDOWN_MS = 1500;

/** The most recent barcode that was looked up, and when it happened. */
export interface RecentScan {
  isbn: string;
  at: number;
}

/**
 * True when `isbn` matches the previous scan and is still inside the cooldown,
 * so the caller skips re-looking-up a barcode the camera keeps seeing.
 */
export function isDuplicateScan(
  previous: RecentScan | null,
  isbn: string,
  now: number,
  cooldownMs: number = DUPLICATE_ISBN_COOLDOWN_MS,
): boolean {
  return (
    previous !== null && previous.isbn === isbn && now - previous.at < cooldownMs
  );
}

/** A snapshot of the video element, used by the stall watchdog. */
export interface VideoHealthSample {
  readyState: number;
  currentTime: number;
}

/**
 * True when the video feed looks stalled: metadata is not ready, or the
 * playback clock has not advanced since the previous sample. A `null` previous
 * sample only reports a stall when the feed is not even ready.
 */
export function isVideoStalled(
  previous: VideoHealthSample | null,
  current: VideoHealthSample,
): boolean {
  if (current.readyState < 2) return true;
  if (previous === null) return false;
  return current.currentTime <= previous.currentTime;
}
