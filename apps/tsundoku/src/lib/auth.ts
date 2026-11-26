import { betterAuth, type BetterAuthOptions } from "better-auth";
import {
  buildResetPasswordEmail,
  buildVerificationEmail,
  createEmailSender,
  DEFAULT_EMAIL_FROM,
} from "./email";

/**
 * The subset of Cloudflare bindings Better Auth needs. Passed in explicitly
 * instead of reading the module-level `cloudflare:workers` `env` so the factory
 * stays a pure function of the current request's bindings (no stale singleton).
 */
export interface AuthBindings {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  AUTH_EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  MICROSOFT_TENANT_ID?: string;
  MICROSOFT_TENANT_SECRET?: string;
}

export const DEFAULT_BASE_URL = "https://tsundoku.singbaobao.com";

/** Origins allowed to start auth requests during local dev / preview. */
const DEV_TRUSTED_ORIGINS = [
  "http://localhost:8787",
  "http://localhost:4321",
] as const;

/**
 * Build a Better Auth instance bound to the given Cloudflare `env`. Call once
 * per request from the middleware and the `/api/auth/*` catch-all route.
 *
 * OAuth providers are only registered when both their id and secret are
 * present, so a partially-configured environment disables that provider instead
 * of misbehaving. Email verification and password reset route through Resend,
 * which degrades to a logged no-op when `RESEND_API_KEY` is unset.
 */
export function createAuth(env: AuthBindings) {
  const baseURL = env.BETTER_AUTH_URL ?? DEFAULT_BASE_URL;
  const sendEmail = createEmailSender({
    apiKey: env.RESEND_API_KEY,
    from: env.AUTH_EMAIL_FROM ?? DEFAULT_EMAIL_FROM,
  });

  const socialProviders: NonNullable<BetterAuthOptions["socialProviders"]> = {};

  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    socialProviders.github = {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      prompt: "select_account",
    };
  }

  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      prompt: "select_account",
    };
  }

  if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) {
    socialProviders.microsoft = {
      clientId: env.MICROSOFT_CLIENT_ID,
      clientSecret: env.MICROSOFT_CLIENT_SECRET,
      tenantId:
        env.MICROSOFT_TENANT_ID ?? env.MICROSOFT_TENANT_SECRET ?? "common",
      prompt: "select_account",
    };
  }

  return betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL,
    trustedOrigins: [baseURL, ...DEV_TRUSTED_ORIGINS],
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => {
        await sendEmail(buildResetPasswordEmail({ to: user.email, url }));
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail(buildVerificationEmail({ to: user.email, url }));
      },
    },
    socialProviders,
  });
}
