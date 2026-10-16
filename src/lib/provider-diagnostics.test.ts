import { beforeEach, describe, expect, it, vi } from "vitest";

let reportProviderAuthDiagnostic: typeof import("./provider-diagnostics.ts").reportProviderAuthDiagnostic;
let reportProviderHttpDiagnostic: typeof import("./provider-diagnostics.ts").reportProviderHttpDiagnostic;
let runWithProviderTokenDiagnostics: typeof import("./provider-token-diagnostic-context.ts").runWithProviderTokenDiagnostics;
let runTransactionEffects: typeof import("../db/transaction-effects.ts").runTransactionEffects;

const { debug, warn, captureException } = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("../logger.ts", () => ({ logger: { debug, warn } }));
vi.mock("./error-reporting.ts", () => ({ captureException }));
vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "user-123",
}));

beforeEach(async () => {
  vi.resetModules();
  ({ reportProviderAuthDiagnostic, reportProviderHttpDiagnostic } = await import(
    "./provider-diagnostics.ts"
  ));
  ({ runWithProviderTokenDiagnostics } = await import("./provider-token-diagnostic-context.ts"));
  ({ runTransactionEffects } = await import("../db/transaction-effects.ts"));
  vi.clearAllMocks();
});

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
      await reportProviderHttpDiagnostic(providerId, response, url, init);
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
    await reportProviderHttpDiagnostic(
      "provider",
      new Response("private", { status: Number(status) }),
      new Request("https://api.example.com/me"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`"category":"${category}"`));
    expect(captureException).toHaveBeenCalledTimes(status === 403 ? 1 : 0);
    expect(
      JSON.parse(warn.mock.calls[0]?.[0].replace("[provider-diagnostics] ", "")),
    ).not.toHaveProperty("authErrors");
  });

  it("passes successful responses through without failure telemetry", async () => {
    const response = Response.json({ ok: true });
    await reportProviderHttpDiagnostic("provider", response, new URL("https://api.example.com/me"));
    expect(warn).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it.each(["strava", "wahoo", "peloton"])(
    "records allowlisted auth codes for %s without leaking response fields",
    async (providerId) => {
      const response = Response.json(
        {
          error: "invalid_token",
          error_description: "access-token-secret",
          errors: [
            { resource: "AccessToken", field: "access_token", code: "expired", message: "private" },
            { resource: "secret-account", field: "secret-field", code: "secret-code" },
          ],
        },
        { status: 401 },
      );
      await reportProviderHttpDiagnostic(providerId, response, "https://api.example.com/me");
      expect(captureException.mock.calls[0]?.[1].extra).toMatchObject({
        authErrors: [
          { code: "invalid_token" },
          { resource: "AccessToken", field: "access_token", code: "expired" },
        ],
      });
      expect(await response.json()).toMatchObject({ error_description: "access-token-secret" });
      const output = JSON.stringify([warn.mock.calls, captureException.mock.calls]);
      for (const secret of [
        "access-token-secret",
        "private",
        "secret-account",
        "secret-field",
        "secret-code",
      ])
        expect(output).not.toContain(secret);
    },
  );

  it("still reports rejection when an advertised JSON body is malformed", async () => {
    const response = new Response("malformed private-json", {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
    await reportProviderHttpDiagnostic("provider", response, "https://api.example.com/me");
    expect(captureException).toHaveBeenCalledOnce();
    expect(captureException.mock.calls[0]?.[1].extra.statusCode).toBe(401);
    expect(captureException.mock.calls[0]?.[1].extra).not.toHaveProperty("authErrors");
    expect(await response.text()).toBe("malformed private-json");
    expect(JSON.stringify([warn.mock.calls, captureException.mock.calls])).not.toContain(
      "private-json",
    );
  });

  it.each([401, 403])("records structured codes for HTTP %s", async (status) => {
    await reportProviderHttpDiagnostic(
      "provider",
      Response.json({ errors: [{ code: "insufficient_scope" }] }, { status }),
      "https://api.example.com/me",
    );
    expect(captureException.mock.calls[0]?.[1].extra.authErrors).toEqual([
      { code: "insufficient_scope" },
    ]);
  });

  it.each([
    Response.json(null, { status: 401 }),
    Response.json({ errors: "private-invalid-errors" }, { status: 401 }),
    Response.json({ error: "private-unknown-code" }, { status: 401 }),
    new Response('{"error":"invalid_token"}', { status: 401 }),
    Response.json({ error: "invalid_token" }, { status: 500 }),
  ])("omits unverified auth evidence for response %#", async (response) => {
    await reportProviderHttpDiagnostic("provider", response.clone(), "https://api.example.com/me");
    const diagnostic = JSON.parse(warn.mock.calls[0]?.[0].replace("[provider-diagnostics] ", ""));
    expect(diagnostic).not.toHaveProperty("authErrors");
  });

  it("reports body transport errors with sanitized context", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("private-read-secret"));
        },
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
    await reportProviderHttpDiagnostic("provider", response, "https://api.example.com/me");
    expect(captureException).toHaveBeenCalledTimes(2);
    expect(captureException.mock.calls[0]?.[0].message).toBe(
      "Unable to read provider authorization diagnostic response",
    );
    expect(captureException.mock.calls[0]?.[1]).toEqual({
      tags: { provider: "provider", operation: "provider-http-diagnostics" },
    });
    expect(captureException.mock.calls[1]?.[1].extra).not.toHaveProperty("authErrors");
    expect(JSON.stringify([warn.mock.calls, captureException.mock.calls])).not.toContain(
      "private-read-secret",
    );
  });

  it("records known expiry without inventing request timing", async () => {
    await runWithProviderTokenDiagnostics("user-123", async () => {
      reportProviderAuthDiagnostic("provider", "tokens_loaded", undefined, {
        expiresAt: new Date("2026-10-08T20:00:00Z"),
        refreshToken: null,
      });
      await reportProviderHttpDiagnostic(
        "provider",
        new Response(null, { status: 401 }),
        "https://api.example.com/me",
      );
      const diagnostic = captureException.mock.calls[0]?.[1].extra;
      expect(diagnostic.tokenExpiresAt).toBe("2026-10-08T20:00:00.000Z");
      expect(diagnostic).not.toHaveProperty("tokenExpiresInSecondsAtRequestStart");
      expect(diagnostic).not.toHaveProperty("requestStartedAt");
    });
  });
});

describe("reportProviderAuthDiagnostic", () => {
  it.each(["tokens_missing", "tokens_deleted"] as const)(
    "clears expiry after %s",
    async (event) => {
      await runWithProviderTokenDiagnostics("user-123", async () => {
        reportProviderAuthDiagnostic("provider", "tokens_loaded", undefined, {
          expiresAt: new Date("2026-10-08T20:00:00Z"),
          refreshToken: null,
        });
        reportProviderAuthDiagnostic("provider", event);
        await reportProviderHttpDiagnostic(
          "provider",
          new Response(null, { status: 401 }),
          "https://api.example.com/me",
        );
        expect(captureException.mock.calls[0]?.[1].extra).not.toHaveProperty("tokenExpiresAt");
      });
    },
  );

  it.each(["sign_in_started", "refresh_started"] as const)(
    "retains loaded expiry during %s",
    async (event) => {
      await runWithProviderTokenDiagnostics("user-123", async () => {
        reportProviderAuthDiagnostic("provider", "tokens_loaded", undefined, {
          expiresAt: new Date("2026-10-08T20:00:00Z"),
          refreshToken: null,
        });
        reportProviderAuthDiagnostic("provider", event);
        await reportProviderHttpDiagnostic(
          "provider",
          new Response(null, { status: 401 }),
          "https://api.example.com/me",
        );
        expect(captureException.mock.calls[0]?.[1].extra.tokenExpiresAt).toBe(
          "2026-10-08T20:00:00.000Z",
        );
      });
    },
  );
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
