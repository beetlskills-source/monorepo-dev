/**
 * Transactional email delivery via Resend, plus the pure builders for the
 * Better Auth verification and password-reset messages.
 *
 * Delivery is best-effort: a missing API key or an upstream failure is logged
 * and reported as `false` rather than thrown, so the auth request that
 * triggered the email still completes (matching the "degrade, don't 500" rule
 * the lookup pipeline follows).
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailSenderOptions {
  /** Resend API key. When absent, sending is skipped. */
  apiKey?: string;
  /** `From` header. Defaults to the shared no-reply address. */
  from?: string;
  /** Injectable fetch for deterministic tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type EmailSender = (message: EmailMessage) => Promise<boolean>;

export const DEFAULT_EMAIL_FROM = "Tsundoku <no-reply@singbaobao.com>";
export const RESEND_ENDPOINT = "https://api.resend.com/emails";
export const DEFAULT_EMAIL_TIMEOUT_MS = 10_000;

interface EmailAction {
  to: string;
  url: string;
}

/** Verification email sent after sign-up (and on resend). */
export function buildVerificationEmail({ to, url }: EmailAction): EmailMessage {
  return {
    to,
    subject: "Verify your Tsundoku email",
    text: `Confirm your email address to finish setting up your Tsundoku account:\n\n${url}\n\nIf you did not create an account, you can ignore this email.`,
    html: [
      "<p>Confirm your email address to finish setting up your Tsundoku account.</p>",
      `<p><a href="${url}">Verify email</a></p>`,
      "<p>If you did not create an account, you can ignore this email.</p>",
    ].join("\n"),
  };
}

/** Password-reset email sent by the forgot-password flow. */
export function buildResetPasswordEmail({ to, url }: EmailAction): EmailMessage {
  return {
    to,
    subject: "Reset your Tsundoku password",
    text: `Reset your Tsundoku password using the link below:\n\n${url}\n\nIf you did not request this, you can ignore this email.`,
    html: [
      "<p>Reset your Tsundoku password using the link below.</p>",
      `<p><a href="${url}">Reset password</a></p>`,
      "<p>If you did not request this, you can ignore this email.</p>",
    ].join("\n"),
  };
}

/**
 * Build a Resend-backed sender. Returns a function that never throws: callers
 * receive `true` only when Resend accepted the message.
 */
export function createEmailSender(options: EmailSenderOptions = {}): EmailSender {
  const from = options.from ?? DEFAULT_EMAIL_FROM;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EMAIL_TIMEOUT_MS;

  return async function send(message: EmailMessage): Promise<boolean> {
    const apiKey = options.apiKey;
    if (!apiKey) {
      console.warn(
        "[email] RESEND_API_KEY is not configured; skipping outbound email.",
      );
      return false;
    }

    const fetchImpl = options.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        console.warn(
          `[email] Resend rejected the message (status ${response.status}).`,
        );
        return false;
      }
      return true;
    } catch (error) {
      // Never surface the key or a stack trace.
      console.warn(
        "[email] Failed to send email:",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  };
}
