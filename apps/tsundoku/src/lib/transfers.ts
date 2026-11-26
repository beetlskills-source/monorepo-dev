/**
 * Phase 4 ownership transfer service: move one book from the sender's own
 * Google Sheet to an eligible recipient's sheet, then record the attempt in D1.
 *
 * The order is deliberate — append first, remove second — so a failed append
 * never silently drops the book. If the append fails the sender's row is left
 * exactly as it was; if the append succeeds but the sender's row cannot be
 * removed, the book is only duplicated (never lost) and a cleanup warning is
 * returned. Kept free of Astro APIs so it stays testable.
 */

import { z } from "zod";
import { errorResponse } from "./http";
import { resolveOwnContext } from "./own-shelf";
import {
  createTransferId,
  recordOwnershipTransfer,
  type OwnershipTransferRecord,
} from "./ownership-transfers";
import { getTransferTarget } from "./shelf-configs";
import {
  isEmptyRow,
  shelfRowFromCanonical,
  shelfRowRange,
  shelfRowToValues,
  type ShelfRow,
} from "./shelf-rows";
import { sheetRange } from "./sheet-flow";
import {
  getAuthorizedAccessToken,
  googleSheetsErrorResponse,
  SheetConnectionError,
  type SheetsEnv,
} from "./sheet-service";

/** Body for `POST /api/shelves/transfers` (row 1 is the header, so min is 2). */
export const TransferRequestSchema = z.object({
  rowIndex: z.number().int().min(2),
  targetUserId: z.string().trim().min(1),
});

export type TransferRequest = z.infer<typeof TransferRequestSchema>;

/** A book that was successfully appended to the recipient's shelf. */
export interface TransferSuccess {
  ok: true;
  status: "completed";
  transferId: string;
  from: { userId: string; email: string };
  to: { userId: string; email: string };
  /** The row as written to the recipient's sheet (ownerEmail/transferredFrom updated). */
  row: ShelfRow;
  /** False when the sender's row could not be removed (the book is duplicated). */
  removedFromSender: boolean;
  /** Cleanup guidance when the sender's row could not be removed; `null` otherwise. */
  warning: string | null;
}

export interface TransferInput {
  fromUserId: string;
  fromEmail: string;
  rowIndex: number;
  targetUserId: string;
}

const REMOVAL_WARNING =
  "The book was added to the recipient's shelf, but it could not be removed from yours. Remove it manually to avoid a duplicate.";

/** Best-effort audit insert: a storage hiccup must never fail a real transfer. */
async function writeAudit(
  env: SheetsEnv,
  record: OwnershipTransferRecord,
): Promise<void> {
  try {
    await recordOwnershipTransfer(env.DB, record);
  } catch {
    // Auditing is best-effort; the transfer outcome has already been decided.
  }
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Google Sheets error.";
}

/**
 * Execute an ownership transfer. Returns a {@link TransferSuccess} on success,
 * or a JSON error {@link Response} describing an unmet prerequisite or an
 * upstream failure (with the sender's sheet left untouched).
 */
export async function transferBook(
  env: SheetsEnv,
  input: TransferInput,
): Promise<TransferSuccess | Response> {
  if (input.targetUserId === input.fromUserId) {
    return errorResponse(
      400,
      "INVALID_TARGET",
      "Choose a different recipient to transfer this book to.",
    );
  }

  const sender = await resolveOwnContext(env, input.fromUserId);
  if (sender instanceof Response) return sender;

  // Read the source row so ownership is verified and its canonical fields copied.
  let sourceCells: string[];
  try {
    const values = await sender.client.getValues({
      accessToken: sender.accessToken,
      spreadsheetId: sender.spreadsheetId,
      range: shelfRowRange(sender.sheetTabName, input.rowIndex),
    });
    sourceCells = values[0] ?? [];
  } catch (error) {
    return googleSheetsErrorResponse(error);
  }
  const sourceRow = shelfRowFromCanonical(input.rowIndex, sourceCells);
  if (isEmptyRow(sourceRow)) {
    return errorResponse(
      404,
      "ROW_NOT_FOUND",
      "That row no longer exists. Refresh the shelf and try again.",
    );
  }

  // Verify target eligibility server-side (never trust the picker): a bound
  // sheet with incoming transfers enabled, and — Phase 5 — an active group
  // shared with the sender.
  const target = await getTransferTarget(env.DB, input.targetUserId, input.fromUserId);
  if (!target) {
    return errorResponse(
      409,
      "TARGET_NOT_ELIGIBLE",
      "That reader cannot receive transfers right now. Transfers are limited to readers who share a group with you.",
    );
  }

  // Mint the recipient's access token server-side; their refresh token never leaves D1.
  let targetAccessToken: string;
  try {
    const authorized = await getAuthorizedAccessToken(
      env,
      sender.client,
      target.userId,
    );
    targetAccessToken = authorized.accessToken;
  } catch (error) {
    if (error instanceof SheetConnectionError) {
      return errorResponse(
        409,
        "TARGET_NOT_ELIGIBLE",
        "That reader's Google connection needs re-authorization before they can receive books.",
      );
    }
    return googleSheetsErrorResponse(error);
  }

  const now = new Date().toISOString();
  const transferId = createTransferId();
  const transferred: ShelfRow = {
    ...sourceRow,
    ownerEmail: target.email,
    transferredFrom: input.fromEmail,
    addedAt: now,
    visibility: target.defaultVisibility,
    // Group tags are the sender's target list; the recipient re-tags the book
    // for their own groups after receiving it.
    groups: "",
  };

  const auditBase: Omit<
    OwnershipTransferRecord,
    "status" | "errorMessage" | "completedAt"
  > = {
    id: transferId,
    fromUserId: input.fromUserId,
    fromEmail: input.fromEmail,
    toUserId: target.userId,
    toEmail: target.email,
    fromSpreadsheetId: sender.spreadsheetId,
    fromSheetTabName: sender.sheetTabName,
    toSpreadsheetId: target.spreadsheetId,
    toSheetTabName: target.sheetTabName,
    isbn13: sourceRow.isbn13,
    title: sourceRow.title || null,
    createdAt: now,
  };

  // Step 2: append to the recipient's sheet. Failure leaves the sender untouched.
  try {
    await sender.client.appendValues({
      accessToken: targetAccessToken,
      spreadsheetId: target.spreadsheetId,
      range: sheetRange(target.sheetTabName, "A1"),
      values: [shelfRowToValues(transferred)],
    });
  } catch (error) {
    await writeAudit(env, {
      ...auditBase,
      status: "failed",
      errorMessage: failureMessage(error),
      completedAt: null,
    });
    return googleSheetsErrorResponse(error);
  }

  // Step 3: only now remove the sender's row — the append already persisted the
  // book. A removal failure can only duplicate, never lose, the entry.
  let removedFromSender = false;
  try {
    const meta = await sender.client.getSpreadsheetMeta({
      accessToken: sender.accessToken,
      spreadsheetId: sender.spreadsheetId,
    });
    const match = meta.sheets.find(
      (sheet) => sheet.title === sender.sheetTabName,
    );
    if (match?.sheetId != null) {
      await sender.client.batchUpdate({
        accessToken: sender.accessToken,
        spreadsheetId: sender.spreadsheetId,
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: match.sheetId,
                dimension: "ROWS",
                startIndex: input.rowIndex - 1,
                endIndex: input.rowIndex,
              },
            },
          },
        ],
      });
      removedFromSender = true;
    }
  } catch {
    // The book is safe on the recipient's shelf; surface a manual-cleanup hint.
  }

  await writeAudit(env, {
    ...auditBase,
    status: "completed",
    errorMessage: removedFromSender ? null : REMOVAL_WARNING,
    completedAt: now,
  });

  return {
    ok: true,
    status: "completed",
    transferId,
    from: { userId: input.fromUserId, email: input.fromEmail },
    to: { userId: target.userId, email: target.email },
    row: transferred,
    removedFromSender,
    warning: removedFromSender ? null : REMOVAL_WARNING,
  };
}
