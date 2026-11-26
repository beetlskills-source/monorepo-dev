/**
 * D1 accessor for the `ownership_transfers` audit table (Phase 4). Every
 * transfer attempt writes one row capturing who moved a book to whom, the
 * source/target sheet locations, and the outcome, so a failed or partial
 * transfer stays traceable. Takes the `D1Database` binding so the helper stays
 * a pure function of the current request's environment.
 */

export type OwnershipTransferStatus = "pending" | "completed" | "failed";

/** One audit row describing a transfer attempt and its outcome. */
export interface OwnershipTransferRecord {
  id: string;
  fromUserId: string;
  fromEmail: string;
  toUserId: string;
  toEmail: string;
  fromSpreadsheetId: string | null;
  fromSheetTabName: string | null;
  toSpreadsheetId: string | null;
  toSheetTabName: string | null;
  isbn13: string;
  title: string | null;
  status: OwnershipTransferStatus;
  /** Reason for a `failed` (or partial) outcome; `null` on a clean success. */
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** Generate a stable, collision-resistant transfer id. */
export function createTransferId(): string {
  return crypto.randomUUID();
}

/**
 * Persist one transfer audit row. Kept as a plain insert so callers decide how
 * to react to a storage failure.
 */
export async function recordOwnershipTransfer(
  db: D1Database,
  record: OwnershipTransferRecord,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ownership_transfers (
         id, from_user_id, from_email, to_user_id, to_email,
         from_spreadsheet_id, from_sheet_tab_name, to_spreadsheet_id, to_sheet_tab_name,
         isbn13, title, status, error_message, created_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.id,
      record.fromUserId,
      record.fromEmail,
      record.toUserId,
      record.toEmail,
      record.fromSpreadsheetId,
      record.fromSheetTabName,
      record.toSpreadsheetId,
      record.toSheetTabName,
      record.isbn13,
      record.title,
      record.status,
      record.errorMessage,
      record.createdAt,
      record.completedAt,
    )
    .run();
}
