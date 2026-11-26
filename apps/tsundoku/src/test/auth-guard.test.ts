import { describe, expect, it } from "vitest";
import {
  LOGIN_PATH,
  isProtectedPath,
  loginRedirectUrl,
  safeNextPath,
} from "../lib/auth-guard";

describe("isProtectedPath", () => {
  it("protects the dashboard root and its subpaths", () => {
    expect(isProtectedPath("/dashboard")).toBe(true);
    expect(isProtectedPath("/dashboard/settings")).toBe(true);
  });

  it("protects the settings route", () => {
    expect(isProtectedPath("/settings")).toBe(true);
    expect(isProtectedPath("/settings/shelf")).toBe(true);
    expect(isProtectedPath("/settingsish")).toBe(false);
  });

  it("leaves public routes and lookalikes open", () => {
    expect(isProtectedPath("/")).toBe(false);
    expect(isProtectedPath("/login")).toBe(false);
    expect(isProtectedPath("/api/isbn-lookup")).toBe(false);
    // Must not match a prefix that merely shares the string ("/dashboardish").
    expect(isProtectedPath("/dashboardish")).toBe(false);
  });
});

describe("loginRedirectUrl", () => {
  it("preserves the intended destination for post-login", () => {
    expect(loginRedirectUrl("/dashboard")).toBe(
      `${LOGIN_PATH}?next=%2Fdashboard`,
    );
  });

  it("encodes destinations containing a query string", () => {
    expect(loginRedirectUrl("/dashboard/shelf?page=2")).toBe(
      `${LOGIN_PATH}?next=%2Fdashboard%2Fshelf%3Fpage%3D2`,
    );
  });
});

describe("safeNextPath", () => {
  it("accepts same-origin absolute paths", () => {
    expect(safeNextPath("/dashboard")).toBe("/dashboard");
    expect(safeNextPath("/dashboard/shelf")).toBe("/dashboard/shelf");
  });

  it("falls back for empty or missing values", () => {
    expect(safeNextPath(null)).toBe("/dashboard");
    expect(safeNextPath(undefined)).toBe("/dashboard");
    expect(safeNextPath("")).toBe("/dashboard");
  });

  it("honours a custom fallback", () => {
    expect(safeNextPath(null, "/login")).toBe("/login");
  });

  it("rejects absolute URLs and protocol-relative values", () => {
    expect(safeNextPath("https://evil.com")).toBe("/dashboard");
    expect(safeNextPath("//evil.com")).toBe("/dashboard");
    expect(safeNextPath("/\\evil.com")).toBe("/dashboard");
  });

  it("rejects relative paths that browsers would resolve cross-origin", () => {
    expect(safeNextPath("evil.com")).toBe("/dashboard");
  });
});
