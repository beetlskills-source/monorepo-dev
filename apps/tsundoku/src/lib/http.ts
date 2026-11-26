/** Minimal JSON response helpers shared by the API routes. */

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Shape of every non-2xx response from the sheet endpoints. */
export interface ApiErrorBody {
  error: string;
  message: string;
}

export function errorResponse(
  status: number,
  error: string,
  message: string,
): Response {
  return jsonResponse({ error, message } satisfies ApiErrorBody, status);
}
