/**
 * Pure helpers for the Google Sheet connection flow: PKCE, the short-lived
 * OAuth state cookie, sheet ranges, the canonical header row, and the
 * book → row mapping. Kept free of Worker/Astro APIs so they are deterministic
 * and unit-testable.
 */

import { z } from "zod";
import type { BookLookupResult } from "@repo/book-schemas";
import { toBase64Url, fromBase64Url } from "./crypto";
import {
  DEFAULT_SHEET_TAB_NAME,
  type DefaultVisibility,
} from "./shelf-configs";

/** Canonical Google Sheet columns, in write order (A..O). */
export const SHEET_HEADER_ROW = [
  "isbn13",
  "title",
  "authors",
  "publisher",
  "publishedYear",
  "summary",
  "source",
  "verified",
  "enriched",
  "confidence",
  "visibility",
  "ownerEmail",
  "addedAt",
  "transferredFrom",
  "groups",
] as const;

/** Name of the short-lived HttpOnly cookie carrying OAuth state + verifier. */
export const SHEETS_OAUTH_COOKIE = "tsundoku.sheets_oauth";

/** Lifetime of the in-flight connect attempt, in seconds. */
export const SHEETS_OAUTH_COOKIE_MAX_AGE = 600;

/** Separator used to flatten the `authors` array into a single cell. */
export const AUTHORS_SEPARATOR = "; ";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** A cryptographically-random, URL-safe token (unpadded base64url). */
export function createRandomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Create an RFC 7636 PKCE verifier/challenge pair (S256). */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = createRandomToken(64);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: toBase64Url(new Uint8Array(digest)) };
}

/** Encode the OAuth state + PKCE verifier into an opaque cookie value. */
export function encodeOAuthStateCookie(state: string, verifier: string): string {
  return toBase64Url(
    new TextEncoder().encode(JSON.stringify({ state, verifier })),
  );
}

/** Decode a cookie produced by {@link encodeOAuthStateCookie}, or `null`. */
export function decodeOAuthStateCookie(
  value: string,
): { state: string; verifier: string } | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(value)));
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      if (
        typeof record.state === "string" &&
        typeof record.verifier === "string"
      ) {
        return { state: record.state, verifier: record.verifier };
      }
    }
  } catch {
    // Malformed/tampered cookie: treat as absent.
  }
  return null;
}

/**
 * Serialize the short-lived OAuth state cookie. Returned as a raw header value
 * so the route can attach it to a redirect response deterministically, without
 * depending on adapter-specific cookie merging.
 */
export function serializeOAuthStateCookie(value: string, secure: boolean): string {
  const parts = [
    `${SHEETS_OAUTH_COOKIE}=${value}`,
    `Max-Age=${SHEETS_OAUTH_COOKIE_MAX_AGE}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Serialize a `Set-Cookie` value that immediately expires the state cookie. */
export function clearOAuthStateCookie(secure: boolean): string {
  const parts = [
    `${SHEETS_OAUTH_COOKIE}=`,
    "Max-Age=0",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Build an A1 range (e.g. `'Books'!A1:N1`) for a possibly-spaced tab name. */
export function sheetRange(tabName: string, a1: string): string {
  const safeTab = (tabName.trim() || DEFAULT_SHEET_TAB_NAME).replace(/'/g, "''");
  return `'${safeTab}'!${a1}`;
}

/** Convert a 1-based column count into its spreadsheet letter (14 → `N`). */
export function columnLetter(count: number): string {
  let remaining = count;
  let letters = "";
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letters;
}

/** A1 range spanning exactly the {@link SHEET_HEADER_ROW} columns (e.g. `A1:O1`). */
export function sheetHeaderRange(tabName: string): string {
  return sheetRange(tabName, `A1:${columnLetter(SHEET_HEADER_ROW.length)}1`);
}

export interface SheetRowInput {
  book: BookLookupResult;
  visibility: DefaultVisibility;
  ownerEmail: string;
  addedAt: string;
  transferredFrom?: string | null;
}

/**
 * Flatten a normalized lookup result into a row matching {@link SHEET_HEADER_ROW}.
 * Nullable fields become empty strings so the sheet stays type-stable. The
 * `groups` column starts empty — a newly saved row belongs to no group until
 * the owner targets it from the dashboard.
 */
export function buildSheetRow(input: SheetRowInput): string[] {
  const { book } = input;
  return [
    book.isbn13,
    book.title,
    book.authors.join(AUTHORS_SEPARATOR),
    book.publisher ?? "",
    book.publishedYear === null ? "" : String(book.publishedYear),
    book.summary ?? "",
    book.source,
    String(book.verified),
    String(book.enriched),
    book.confidence,
    input.visibility,
    input.ownerEmail,
    input.addedAt,
    input.transferredFrom ?? "",
    "",
  ];
}

/** Body for `POST /api/sheets/shelf` (create a new sheet, bind, or detach). */
export const ShelfSetupRequestSchema = z.object({
  action: z.enum(["create", "bind", "detach"]),
  spreadsheetId: z.string().trim().min(1).optional(),
  /** Target tab when binding; defaults to the spreadsheet's first tab. */
  sheetTabName: z.string().trim().min(1).optional(),
});

export type ShelfSetupRequest = z.infer<typeof ShelfSetupRequestSchema>;

/** Body for `POST /api/sheets/settings`. */
export const ShelfSettingsRequestSchema = z.object({
  defaultVisibility: z.enum(["private", "shared"]),
  allowIncomingTransfers: z.boolean(),
});

export type ShelfSettingsRequest = z.infer<typeof ShelfSettingsRequestSchema>;

/**
 * Body for `POST /api/shelves/visibility` (Phase 6). Level 2 of the visibility
 * model: whether the user's whole Google Sheet is published to co-members.
 * Deliberately separate from `ShelfSettingsRequest.defaultVisibility`.
 */
export const SheetVisibilityRequestSchema = z.object({
  sheetVisibility: z.enum(["private", "shared"]),
});

export type SheetVisibilityRequest = z.infer<typeof SheetVisibilityRequestSchema>;

/**
 * Body for `POST /api/sheets/save-book`. Validated in two steps (an envelope
 * first, then the book) because nesting `BookLookupResultSchema` directly
 * pushes Zod's type inference past its depth limit.
 */
export interface SaveBookRequest {
  book: BookLookupResult;
}
