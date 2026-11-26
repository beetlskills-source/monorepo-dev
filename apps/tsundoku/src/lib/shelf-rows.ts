/**
 * Pure helpers mapping between canonical Google Sheet rows and typed shelf
 * items (Phase 3). Columns follow `SHEET_HEADER_ROW` order (A..O); a 1-based
 * `rowIndex` ties every item back to its spreadsheet row so edits and deletes
 * target the exact grid row. Kept free of Worker/Astro APIs so mapping,
 * filtering, and editing stay deterministic and unit-testable.
 */

import { z } from "zod";
import { columnLetter, sheetRange, SHEET_HEADER_ROW } from "./sheet-flow";

/** Number of canonical columns (15 → `O`). */
export const SHELF_COLUMN_COUNT = SHEET_HEADER_ROW.length;

/** 1-based spreadsheet row that holds the header (data starts at row 2). */
export const SHEET_HEADER_ROW_INDEX = 1;

export type ShelfVisibility = "private" | "shared";

/** One shelf entry, keyed to its 1-based spreadsheet row. */
export interface ShelfRow {
  rowIndex: number;
  isbn13: string;
  title: string;
  authors: string;
  publisher: string;
  publishedYear: string;
  summary: string;
  source: string;
  verified: string;
  enriched: string;
  confidence: string;
  visibility: string;
  ownerEmail: string;
  addedAt: string;
  transferredFrom: string;
  /**
   * Comma-separated group ids this row is targeted at (Phase 5). Empty means
   * the row is not shown in any group feed.
   */
  groups: string;
}

/** True when the first cell names the canonical `isbn13` column. */
export function isHeaderRow(cells: string[]): boolean {
  return (cells[0] ?? "").trim().toLowerCase() === "isbn13";
}

/** Read a single row from the canonical A..O column order. */
export function shelfRowFromCanonical(
  rowIndex: number,
  cells: string[],
): ShelfRow {
  const cell = (index: number): string => {
    const value = cells[index];
    return value === undefined || value === null ? "" : String(value);
  };
  return {
    rowIndex,
    isbn13: cell(0),
    title: cell(1),
    authors: cell(2),
    publisher: cell(3),
    publishedYear: cell(4),
    summary: cell(5),
    source: cell(6),
    verified: cell(7),
    enriched: cell(8),
    confidence: cell(9),
    visibility: cell(10),
    ownerEmail: cell(11),
    addedAt: cell(12),
    transferredFrom: cell(13),
    groups: cell(14),
  };
}

/** Serialize a shelf row back into canonical A..O column order. */
export function shelfRowToValues(row: ShelfRow): string[] {
  return [
    row.isbn13,
    row.title,
    row.authors,
    row.publisher,
    row.publishedYear,
    row.summary,
    row.source,
    row.verified,
    row.enriched,
    row.confidence,
    row.visibility,
    row.ownerEmail,
    row.addedAt,
    row.transferredFrom,
    row.groups,
  ];
}

/** True when every canonical cell is blank (a spacer row to skip). */
export function isEmptyRow(row: ShelfRow): boolean {
  return shelfRowToValues(row).every((value) => value.trim() === "");
}

/**
 * Map a `values.get` matrix into shelf rows. The header row (when present) is
 * skipped and blank spacer rows are dropped, while `rowIndex` always reflects
 * the true 1-based spreadsheet position so edits/deletes stay aligned.
 */
export function mapSheetValues(values: string[][]): ShelfRow[] {
  if (values.length === 0) return [];
  const hasHeader = isHeaderRow(values[0] ?? []);
  const dataStart = hasHeader ? 1 : 0;

  const rows: ShelfRow[] = [];
  for (let i = dataStart; i < values.length; i += 1) {
    const row = shelfRowFromCanonical(i + 1, values[i] ?? []);
    if (!isEmptyRow(row)) rows.push(row);
  }
  return rows;
}

/** Coerce a raw visibility cell into the two supported values. */
export function normalizeVisibility(value: string): ShelfVisibility {
  return value.trim().toLowerCase() === "shared" ? "shared" : "private";
}

/** True when a row is explicitly marked `shared` and may appear in a shared view. */
export function isSharedRow(row: ShelfRow): boolean {
  return normalizeVisibility(row.visibility) === "shared";
}

/** Keep only rows a viewer is allowed to see on a shared shelf. */
export function filterSharedRows(rows: ShelfRow[]): ShelfRow[] {
  return rows.filter(isSharedRow);
}

/**
 * Parse a row's `groups` cell into a de-duplicated list of group ids. Blank
 * entries and surrounding whitespace are dropped so a hand-edited sheet stays
 * forgiving.
 */
export function parseGroupIds(value: string): string[] {
  const ids = new Set<string>();
  for (const part of value.split(",")) {
    const id = part.trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

/** Serialize group ids back into the canonical comma-separated cell. */
export function serializeGroupIds(ids: string[]): string {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      clean.push(trimmed);
    }
  }
  return clean.join(",");
}

/**
 * Level 3 of the visibility model: a row is visible to a viewer only when it is
 * targeted at (at least) one of the active groups the viewer and the owner
 * share. Rows with zero targeted groups are never shown in a group feed.
 */
export function rowTargetsGroups(row: ShelfRow, groupIds: Set<string>): boolean {
  if (groupIds.size === 0) return false;
  return parseGroupIds(row.groups).some((id) => groupIds.has(id));
}

/** Keep only the rows targeted at one of the supplied common active groups. */
export function filterRowsForGroups(
  rows: ShelfRow[],
  groupIds: Set<string>,
): ShelfRow[] {
  return rows.filter((row) => rowTargetsGroups(row, groupIds));
}

/** A1 range covering every canonical column breadthwise (e.g. `A1:O`). */
export function shelfColumnRange(tabName: string): string {
  return sheetRange(tabName, `A1:${columnLetter(SHELF_COLUMN_COUNT)}`);
}

/** A1 range covering one full shelf row (e.g. `'Books'!A2:O2`). */
export function shelfRowRange(tabName: string, rowIndex: number): string {
  const letter = columnLetter(SHELF_COLUMN_COUNT);
  return sheetRange(tabName, `A${rowIndex}:${letter}${rowIndex}`);
}

/** User-editable fields; everything else is preserved verbatim on save. */
export const ShelfRowEditFieldsSchema = z.object({
  title: z.string().max(500).optional(),
  authors: z.string().max(1000).optional(),
  publisher: z.string().max(500).optional(),
  publishedYear: z.string().max(20).optional(),
  summary: z.string().max(5000).optional(),
  visibility: z.enum(["private", "shared"]).optional(),
  /** Comma-separated group ids the row is targeted at (validated in the route). */
  groups: z.string().max(2000).optional(),
});

export type ShelfRowEditFields = z.infer<typeof ShelfRowEditFieldsSchema>;

/** Body for `PATCH /api/shelves/own/rows` (row 1 is the header, so min is 2). */
export const ShelfRowEditSchema = z.object({
  rowIndex: z.number().int().min(2),
  fields: ShelfRowEditFieldsSchema,
});

export type ShelfRowEdit = z.infer<typeof ShelfRowEditSchema>;

/** Body for `DELETE /api/shelves/own/rows`. */
export const ShelfRowDeleteSchema = z.object({
  rowIndex: z.number().int().min(2),
});

export type ShelfRowDelete = z.infer<typeof ShelfRowDeleteSchema>;

/**
 * Overlay the editable fields onto a row, keeping the authoritative
 * provenance columns (isbn13, source, ownerEmail, …) untouched.
 */
export function applyRowEdits(
  row: ShelfRow,
  fields: ShelfRowEditFields,
): ShelfRow {
  return {
    ...row,
    title: fields.title ?? row.title,
    authors: fields.authors ?? row.authors,
    publisher: fields.publisher ?? row.publisher,
    publishedYear: fields.publishedYear ?? row.publishedYear,
    summary: fields.summary ?? row.summary,
    visibility: fields.visibility ?? row.visibility,
    groups: fields.groups ?? row.groups,
  };
}
