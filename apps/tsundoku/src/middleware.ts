import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";
import { createAuth } from "./lib/auth";
import { isProtectedPath, loginRedirectUrl } from "./lib/auth-guard";

/**
 * Resolve the Better Auth session once per request and expose it on
 * `Astro.locals`, then gate protected routes. The auth instance is created per
 * request so it always sees the current Cloudflare bindings.
 *
 * Asset and auth-endpoint requests skip session resolution: the former never
 * read `locals`, and the latter are handled by Better Auth's own handler.
 */
const SKIP_SESSION_PREFIXES = ["/api/auth", "/_astro", "/_image", "/favicon"];

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.user = null;
  context.locals.session = null;

  const { pathname } = context.url;
  if (SKIP_SESSION_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return next();
  }

  try {
    const auth = createAuth(env);
    const result = await auth.api.getSession({
      headers: context.request.headers,
    });
    context.locals.user = result?.user ?? null;
    context.locals.session = result?.session ?? null;
  } catch (error) {
    console.warn(
      "[middleware] session lookup failed:",
      error instanceof Error ? error.message : error,
    );
  }

  if (isProtectedPath(pathname) && !context.locals.user) {
    // Preserve the query string (e.g. `?invite=<token>`) so it survives the
    // sign-in round-trip.
    return context.redirect(loginRedirectUrl(`${pathname}${context.url.search}`));
  }

  return next();
});
