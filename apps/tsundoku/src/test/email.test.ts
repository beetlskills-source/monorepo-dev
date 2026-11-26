import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EMAIL_FROM,
  RESEND_ENDPOINT,
  buildResetPasswordEmail,
  buildVerificationEmail,
  createEmailSender,
} from "../lib/email";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("email builders", () => {
  it("builds a verification email containing the confirmation URL", () => {
    const message = buildVerificationEmail({
      to: "reader@example.com",
      url: "https://tsundoku.test/api/auth/verify-email?token=abc",
    });

    expect(message.to).toBe("reader@example.com");
    expect(message.subject).toMatch(/verify/i);
    expect(message.text).toContain(
      "https://tsundoku.test/api/auth/verify-email?token=abc",
    );
    expect(message.html).toContain(
      'href="https://tsundoku.test/api/auth/verify-email?token=abc"',
    );
  });

  it("builds a password-reset email containing the reset URL", () => {
    const message = buildResetPasswordEmail({
      to: "reader@example.com",
      url: "https://tsundoku.test/reset-password?token=xyz",
    });

    expect(message.to).toBe("reader@example.com");
    expect(message.subject).toMatch(/reset/i);
    expect(message.text).toContain("https://tsundoku.test/reset-password?token=xyz");
    expect(message.html).toContain(
      'href="https://tsundoku.test/reset-password?token=xyz"',
    );
  });
});

describe("createEmailSender", () => {
  const message = buildVerificationEmail({
    to: "reader@example.com",
    url: "https://tsundoku.test/verify",
  });

  it("skips sending and returns false when no API key is configured", async () => {
    const fetchImpl = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const send = createEmailSender({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(send(message)).resolves.toBe(false);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("posts to Resend and returns true on a 2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    const send = createEmailSender({
      apiKey: "re_test_key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(send(message)).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(RESEND_ENDPOINT);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer re_test_key",
    );
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      from: DEFAULT_EMAIL_FROM,
      to: "reader@example.com",
    });
  });

  it("uses a custom From header when provided", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    const send = createEmailSender({
      apiKey: "re_test_key",
      from: "Custom <custom@example.com>",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(send(message)).resolves.toBe(true);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string).from).toBe(
      "Custom <custom@example.com>",
    );
  });

  it("returns false on a non-2xx response without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 422 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const send = createEmailSender({
      apiKey: "re_test_key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(send(message)).resolves.toBe(false);
  });

  it("returns false and never leaks the API key when the request throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const send = createEmailSender({
      apiKey: "super-secret-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(send(message)).resolves.toBe(false);

    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).not.toContain("super-secret-key");
  });
});
