/**
 * Pure route-protection helpers shared by the SSR middleware and tests. Kept
 * free of Astro/Worker APIs so the redirect policy is deterministic and easy to
 * unit test.
 */

/** Path prefixes that require an authenticated session. */
export const PROTECTED_PREFIXES = ["/dashboard", "/settings"] as const;

/** Where anonymous visitors are sent when they hit a protected route. */
export const LOGIN_PATH = "/login";

/** Returns true when `pathname` requires an authenticated session. */
export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** Builds the login URL, preserving the intended destination for post-login. */
export function loginRedirectUrl(pathname: string): string {
  const next = safeNextPath(pathname);
  return next ? `${LOGIN_PATH}?next=${encodeURIComponent(next)}` : LOGIN_PATH;
}

/**
 * Sanitizes a `next` destination into a same-origin absolute path. Rejects
 * protocol-relative (`//evil.com`) and backslash (`/\evil.com`) values that
 * browsers treat as cross-origin, preventing an open redirect.
 */
export function safeNextPath(
  value: string | null | undefined,
  fallback = "/dashboard",
): string {
  if (!value) return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
  return value;
}
