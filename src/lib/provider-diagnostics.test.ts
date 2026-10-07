import { beforeEach, describe, expect, it, vi } from "vitest";
import { runTransactionEffects } from "../db/transaction-effects.ts";
import {
  reportProviderAuthDiagnostic,
  reportProviderHttpDiagnostic,
} from "./provider-diagnostics.ts";

const { debug, warn, captureException } = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("../logger.ts", () => ({ logger: { debug, warn } }));
vi.mock("./error-reporting.ts", () => ({ captureException }));
vi.mock("../db/token-user-context.ts", () => ({ getTokenUserId: () => "user-123" }));

beforeEach(() => vi.clearAllMocks());

describe("reportProviderHttpDiagnostic", () => {
  it.each(["peloton", "eight-sleep", "garmin"])(
    "reports %s rejection without exposing credentials or consuming the body",
    async (providerId) => {
      const response = new Response("private response token-secret", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Bearer error="invalid_token", error_description="token-secret"',
        },
      });
      const url =
        "https://username:password@api.example.com/user/private-account?token=query-secret";
      const init = {
        method: "POST",
        headers: { Authorization: "Bearer token-secret" },
        body: "password=body-secret",
      };
      reportProviderHttpDiagnostic(providerId, response, url, init);
      expect(await response.text()).toBe("private response token-secret");
      const diagnostic = JSON.parse(warn.mock.calls[0]?.[0].replace("[provider-diagnostics] ", ""));
      expect(diagnostic).toMatchObject({
        providerId,
        userId: "user-123",
        event: "http_failed",
        method: "POST",
        origin: "https://api.example.com",
        statusCode: 401,
        category: "invalid_token",
      });
      expect(diagnostic.endpointHash).toMatch(/^[a-f0-9]{64}$/);
      expect(captureException).toHaveBeenCalledOnce();
      const capturedError = captureException.mock.calls[0]?.[0];
      expect(capturedError.message).toBe(
        `Provider ${providerId} HTTP authorization rejected (401)`,
      );
      expect(capturedError.cause).toBeUndefined();
      const output = JSON.stringify([warn.mock.calls, captureException.mock.calls]);
      for (const secret of [
        "username",
        "password",
        "token-secret",
        "query-secret",
        "body-secret",
        "private-account",
      ])
        expect(output).not.toContain(secret);
    },
  );

  it.each([
    [403, "forbidden"],
    [500, "http_error"],
    [429, "rate_limited"],
  ])("classifies HTTP %s without guessing token expiration", async (status, category) => {
    reportProviderHttpDiagnostic(
      "provider",
      new Response("private", { status: Number(status) }),
      new Request("https://api.example.com/me"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`"category":"${category}"`));
    expect(captureException).toHaveBeenCalledTimes(status === 403 ? 1 : 0);
  });

  it("passes successful responses through without failure telemetry", async () => {
    const response = Response.json({ ok: true });
    reportProviderHttpDiagnostic("provider", response, new URL("https://api.example.com/me"));
    expect(warn).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe("reportProviderAuthDiagnostic", () => {
  it.each(["tokens_loaded", "tokens_missing", "sign_in_started", "refresh_started"] as const)(
    "reports %s immediately even when its transaction later rolls back",
    async (event) => {
      await expect(
        runTransactionEffects(async () => {
          reportProviderAuthDiagnostic("provider", event, "user-123");
          expect(debug).toHaveBeenCalledWith(expect.stringContaining(`"event":"${event}"`));
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(debug).toHaveBeenCalledOnce();
    },
  );

  it.each(["tokens_saved", "tokens_deleted", "sign_in_succeeded", "refresh_succeeded"] as const)(
    "reports %s only after commit",
    async (event) => {
      await runTransactionEffects(async () => {
        reportProviderAuthDiagnostic("provider", event, "user-123");
        expect(debug).not.toHaveBeenCalled();
      });
      expect(debug).toHaveBeenCalledOnce();
      expect(debug).toHaveBeenCalledWith(expect.stringContaining(`"event":"${event}"`));
    },
  );

  it("does not report successful credential persistence when commit rejects", async () => {
    await expect(
      runTransactionEffects(async () => {
        reportProviderAuthDiagnostic("provider", "tokens_saved", "user-123");
        reportProviderAuthDiagnostic("provider", "sign_in_succeeded", "user-123");
        throw new Error("commit failed");
      }),
    ).rejects.toThrow("commit failed");
    expect(debug).not.toHaveBeenCalled();
  });

  it("records credential expiry and refresh availability without token values", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T18:00:00Z"));
    try {
      reportProviderAuthDiagnostic("peloton", "tokens_loaded", "user-123", {
        expiresAt: new Date("2026-10-06T19:00:00Z"),
        refreshToken: "refresh-secret",
      });
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('"expiresInSeconds":3600'));
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('"hasRefreshToken":true'));
      expect(JSON.stringify(debug.mock.calls)).not.toContain("refresh-secret");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports failed credential lifecycle events as sanitized Sentry errors", () => {
    reportProviderAuthDiagnostic("garmin", "sign_in_failed", "user-123");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"sign_in_failed"'));
    expect(captureException.mock.calls[0]?.[0].message).toBe("Provider garmin sign_in_failed");
  });
});
