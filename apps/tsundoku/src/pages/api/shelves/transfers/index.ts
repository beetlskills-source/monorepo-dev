import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse, jsonResponse } from "../../../../lib/http";
import { TransferRequestSchema, transferBook } from "../../../../lib/transfers";

export const prerender = false;

/**
 * Transfer one book from the signed-in user's own shelf to an eligible
 * recipient's shelf. The recipient is re-verified server-side, the book is
 * appended to the recipient's sheet before the sender's row is removed, and the
 * attempt is audited in D1. Shared shelves are read-only and have no transfer
 * surface.
 */
export const POST: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return errorResponse(
      401,
      "UNAUTHENTICATED",
      "Sign in to transfer books from your shelf.",
    );
  }

  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }

  const parsed = TransferRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "Provide a rowIndex (>= 2) and the targetUserId to transfer to.",
    );
  }

  const result = await transferBook(env, {
    fromUserId: user.id,
    fromEmail: user.email,
    rowIndex: parsed.data.rowIndex,
    targetUserId: parsed.data.targetUserId,
  });
  if (result instanceof Response) return result;
  return jsonResponse(result);
};
