import { createRateLimitAwareFetch } from "@dofek/provider-http/rate-limit";
import { beforeEach, expect, it, vi } from "vitest";
import { runWithTokenUser } from "../db/token-user-context.ts";
import { runTransactionEffects } from "../db/transaction-effects.ts";
import { reportProviderAuthDiagnostic } from "./provider-diagnostics.ts";
import { createProviderRateLimitFetch } from "./provider-rate-limit-fetch.ts";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logger.ts", () => ({ logger: { warn, debug: vi.fn() } }));
vi.mock("./error-reporting.ts", () => ({ captureException: vi.fn() }));
vi.mock("./provider-adaptive-rate-limit.ts", () => ({
  providerAdaptiveRateLimitStore: {
    awaitAdmission: vi.fn(),
    recordRateLimit: vi.fn(),
    recordSuccess: vi.fn(),
  },
}));

beforeEach(() => vi.clearAllMocks());

it.each([undefined, "context-user"])(
  "attributes explicit-user HTTP failures when the active context is %s",
  async (contextUser) => {
    const fetchFn = createProviderRateLimitFetch(
      "peloton",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
      { userId: "explicit-user" },
    );
    const request = () => fetchFn("https://api.onepeloton.com/api/me");
    await (contextUser ? runWithTokenUser(contextUser, request) : request());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"userId":"explicit-user"'));
  },
);

it.each([undefined, null])(
  "uses the active user context when the HTTP user is %s",
  async (userId) => {
    const fetchFn = createProviderRateLimitFetch(
      "peloton",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
      { userId },
    );
    await runWithTokenUser("context-user", () => fetchFn("https://api.onepeloton.com/api/me"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"userId":"context-user"'));
  },
);

it("instruments provider failures through the canonical HTTP wrapper", async () => {
  const response = new Response("Unauthorized", { status: 401 });
  const fetchFn = createProviderRateLimitFetch("peloton", vi.fn().mockResolvedValue(response));
  expect(await fetchFn("https://api.onepeloton.com/api/me")).toBe(response);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"http_failed"'));
});

it("keeps the canonical wrapper idempotent so diagnostics and admission are not duplicated", () => {
  const fetchFn = createProviderRateLimitFetch("peloton", vi.fn());
  expect(createProviderRateLimitFetch("peloton", fetchFn)).toBe(fetchFn);
});

it("preserves package-level fetch wrapper idempotence", () => {
  const fetchFn = createRateLimitAwareFetch(vi.fn(), { providerId: "peloton" });
  expect(createProviderRateLimitFetch("peloton", fetchFn)).toBe(fetchFn);
});

it.each(["strava", "wahoo"])(
  "records %s credentials expiring during a request",
  async (providerId) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T14:00:00Z"));
    try {
      const fetchFn = createProviderRateLimitFetch(providerId, async () => {
        vi.setSystemTime(new Date("2026-10-08T14:00:16Z"));
        return Response.json(
          { errors: [{ code: "expired", resource: "AccessToken", field: "access_token" }] },
          { status: 401 },
        );
      });
      await runWithTokenUser("user", async () => {
        reportProviderAuthDiagnostic(providerId, "tokens_loaded", "user", {
          expiresAt: new Date("2026-10-08T14:00:10Z"),
          refreshToken: "refresh-secret",
        });
        await fetchFn("https://api.example.com/me");
      });
      const diagnostic = JSON.parse(warn.mock.calls[0]?.[0].replace("[provider-diagnostics] ", ""));
      expect(diagnostic).toMatchObject({
        tokenExpiresAt: "2026-10-08T14:00:10.000Z",
        tokenExpiresInSecondsAtRequestStart: 10,
        tokenExpiresInSecondsAtResponse: -6,
        hasRefreshToken: true,
        requestStartedAt: "2026-10-08T14:00:00.000Z",
        requestDurationMs: 16000,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("refresh-secret");
    } finally {
      vi.useRealTimers();
    }
  },
);

it("does not attach another user's credential metadata to an explicit-user request", async () => {
  await runWithTokenUser("context-user", async () => {
    reportProviderAuthDiagnostic("peloton", "tokens_loaded", "context-user", {
      expiresAt: new Date("2026-10-08T22:00:00Z"),
      refreshToken: "private-refresh-token",
    });
    const fetchFn = createProviderRateLimitFetch(
      "peloton",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
      { userId: "explicit-user" },
    );
    await fetchFn("https://api.example.com/me");
    const diagnostic = JSON.parse(warn.mock.calls[0]?.[0].replace("[provider-diagnostics] ", ""));
    expect(diagnostic.userId).toBe("explicit-user");
    expect(diagnostic.tokenExpiresAt).toBeUndefined();
  });
});

it("keeps the loaded expiry when a credential save rolls back", async () => {
  await runWithTokenUser("user", async () => {
    reportProviderAuthDiagnostic("wahoo", "tokens_loaded", "user", {
      expiresAt: new Date("2026-10-08T20:00:00Z"),
      refreshToken: null,
    });
    await expect(
      runTransactionEffects(async () => {
        reportProviderAuthDiagnostic("wahoo", "tokens_saved", "user", {
          expiresAt: new Date("2026-10-08T22:00:00Z"),
          refreshToken: null,
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const fetchFn = createProviderRateLimitFetch(
      "wahoo",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );
    await fetchFn("https://api.example.com/me");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"tokenExpiresAt":"2026-10-08T20:00:00.000Z"'),
    );
  });
});
