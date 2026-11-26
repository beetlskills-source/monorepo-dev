import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { createAuth } from "../../../lib/auth";

export const prerender = false;

/**
 * Better Auth catch-all: mounts every auth endpoint (sign-in/up, OAuth
 * callbacks, verify-email, reset-password, session, sign-out, …) at
 * `/api/auth/*`. A fresh instance is built per request from the live bindings.
 */
export const ALL: APIRoute = ({ request }) => createAuth(env).handler(request);
