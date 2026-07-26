import { afterEach, describe, expect, it, vi } from "vitest";
import { authFailureReasonFromError } from "./auth-errors.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createMockDatabase } from "./test-helpers.ts";

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "user-1",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

import { parseUltrahumanMetrics, UltrahumanClient, UltrahumanProvider } from "./ultrahuman.ts";

describe("parseUltrahumanMetrics", () => {
  it("parses resting HR from night_rhr with avg", () => {
    const { daily } = parseUltrahumanMetrics("2026-03-01", [
      { type: "night_rhr", object: { avg: 58.5 } },
    ]);
    expect(daily.restingHr).toBe(59);
  });

  it("parses resting HR from avg_rhr with value", () => {
    const { daily } = parseUltrahumanMetrics("2026-03-01", [
      { type: "avg_rhr", object: { value: 55 } },
    ]);
    expect(daily.restingHr).toBe(55);
  });

  it("parses HRV", () => {
    const { daily } = parseUltrahumanMetrics("2026-03-01", [
      { type: "avg_sleep_hrv", object: { value: 45.5 } },
    ]);
    expect(daily.hrv).toBe(45.5);
  });

  it("parses steps", () => {
    const { daily } = parseUltrahumanMetrics("2026-03-01", [
      { type: "steps", object: { value: 8500.3 } },
    ]);
    expect(daily.steps).toBe(8500);
  });

  it("parses vo2max", () => {
    const { daily } = parseUltrahumanMetrics("2026-03-01", [
      { type: "vo2_max", object: { value: 48.5 } },
    ]);
    expect(daily.vo2max).toBe(48.5);
  });

  it("parses active minutes", () => {
    const { daily } = parseUltrahumanMetrics("2026-03-01", [
      { type: "active_minutes", object: { value: 45.7 } },
    ]);
    expect(daily.exerciseMinutes).toBe(46);
  });

  it("parses body temperature", () => {
    const { daily } = parseUltrahumanMetrics("2026-03-01", [
      { type: "body_temperature", object: { value: 36.5 } },
    ]);
    expect(daily.skinTempC).toBe(36.5);
  });

  it("parses sleep from quick_metrics", () => {
    const { sleep } = parseUltrahumanMetrics("2026-03-01", [
      {
        type: "sleep",
        object: {
          quick_metrics: [
            { type: "total_sleep", value: 28800 }, // 8 hours in seconds = 480 min
            { type: "sleep_index", value: 85 },
          ],
        },
      },
    ]);
    expect(sleep.durationMinutes).toBe(480);
    expect(sleep.sleepScore).toBe(85);
  });

  it("handles non-numeric values gracefully", () => {
    const { daily } = parseUltrahumanMetrics("2026-03-01", [
      { type: "steps", object: { value: "not a number" } },
      { type: "avg_sleep_hrv", object: { value: "bad" } },
    ]);
    expect(daily.steps).toBeUndefined();
    expect(daily.hrv).toBeUndefined();
  });

  it("parses multiple metrics at once", () => {
    const { daily, sleep } = parseUltrahumanMetrics("2026-03-01", [
      { type: "night_rhr", object: { avg: 58 } },
      { type: "avg_sleep_hrv", object: { value: 42 } },
      { type: "steps", object: { value: 10000 } },
      { type: "vo2_max", object: { value: 50 } },
      {
        type: "sleep",
        object: {
          quick_metrics: [{ type: "total_sleep", value: 25200 }],
        },
      },
    ]);
    expect(daily.restingHr).toBe(58);
    expect(daily.hrv).toBe(42);
    expect(daily.steps).toBe(10000);
    expect(daily.vo2max).toBe(50);
    expect(sleep.durationMinutes).toBe(420);
  });

  it("handles sleep without quick_metrics", () => {
    const { sleep } = parseUltrahumanMetrics("2026-03-01", [{ type: "sleep", object: {} }]);
    expect(sleep.durationMinutes).toBeUndefined();
    expect(sleep.sleepScore).toBeUndefined();
  });
});

describe("UltrahumanClient", () => {
  it.each([401, 403])("throws an authentication error for status %s", async (status) => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response("sensitive rejection response", { status }));
    const client = new UltrahumanClient("token", "test@test.com", mockFetch);

    const error = await client.getDailyMetrics("2026-03-01").catch((caught: unknown) => caught);

    expect(authFailureReasonFromError(error)).toBe("authentication_failed");
    expect(error).toMatchObject({
      message:
        "Ultrahuman rejected this token. Create a new personal API token in Ultrahuman Vision and reconnect.",
    });
    expect(error instanceof Error ? error.message : "").not.toContain(
      "sensitive rejection response",
    );
  });

  it("does not classify a 404 response as a rejected token", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response("resource unavailable", { status: 404 }));
    const client = new UltrahumanClient("token", "test@test.com", mockFetch);

    const error = await client.getDailyMetrics("2026-03-01").catch((caught: unknown) => caught);

    expect(authFailureReasonFromError(error)).toBeUndefined();
    expect(error).toMatchObject({
      message: "Ultrahuman API error (404): resource unavailable",
    });
  });

  it("returns parsed response on success", async () => {
    const mockData = {
      data: { metrics: { "2026-03-01": [] } },
      error: null,
      status: 200,
    };
    const mockFetch = vi.fn().mockResolvedValue(Response.json(mockData));
    const client = new UltrahumanClient("token", "test@test.com", mockFetch);
    const result = await client.getDailyMetrics("2026-03-01");
    expect(result.status).toBe(200);
  });

  it("includes the encoded email query when requesting delegated data", async () => {
    const mockFetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      expect(String(input)).toBe(
        "https://partner.ultrahuman.com/api/v1/partner/daily_metrics?email=delegated%2Buser%40example.com&date=2026-03-01",
      );
      return Response.json({ data: { metrics: {} }, error: null, status: 200 });
    });

    await new UltrahumanClient("token", "delegated+user@example.com", mockFetch).getDailyMetrics(
      "2026-03-01",
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("omits the email query for the token owner's own data", async () => {
    const mockFetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      expect(String(input)).toBe(
        "https://partner.ultrahuman.com/api/v1/partner/daily_metrics?date=2026-03-01",
      );
      return Response.json({ data: { metrics: {} }, error: null, status: 200 });
    });

    await new UltrahumanClient("token", undefined, mockFetch).getDailyMetrics("2026-03-01");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("UltrahumanProvider", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("is available without deployment-wide user credentials", () => {
    delete process.env.ULTRAHUMAN_API_TOKEN;
    delete process.env.ULTRAHUMAN_EMAIL;
    expect(new UltrahumanProvider().validate()).toBeNull();
  });

  it("validates and stores a personal API token for its owner", async () => {
    const mockFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(String(input)).toMatch(
        /^https:\/\/partner\.ultrahuman\.com\/api\/v1\/partner\/daily_metrics\?date=\d{4}-\d{2}-\d{2}$/,
      );
      expect(new Headers(init?.headers).get("Authorization")).toBe("personal-token");
      return Response.json({ data: { metrics: {} }, error: null, status: 200 });
    });
    const setup = new UltrahumanProvider(mockFetch).authSetup();

    expect(setup.manualToken).toMatchObject({
      label: "Personal API token",
      instructionsUrl: "https://vision.ultrahuman.com/developer-docs",
    });
    await expect(setup.manualToken?.exchangeToken("personal-token")).resolves.toMatchObject({
      accessToken: "personal-token",
      refreshToken: null,
      scopes: "self",
    });
  });

  it.each([401, 403])("rejects a personal token when validation returns %s", async (status) => {
    const setup = new UltrahumanProvider(
      async () => new Response("sensitive rejection response", { status }),
    ).authSetup();
    if (!setup.manualToken) throw new Error("expected manual token authentication");

    const error = await setup.manualToken
      .exchangeToken("rejected-token")
      .catch((caught: unknown) => caught);

    expect(authFailureReasonFromError(error)).toBe("authentication_failed");
    expect(error).toMatchObject({
      message:
        "Ultrahuman rejected this token. Create a new personal API token in Ultrahuman Vision and try again.",
    });
    expect(error instanceof Error ? error.message : "").not.toContain(
      "sensitive rejection response",
    );
  });

  it("does not classify a 404 validation response as a rejected token", async () => {
    const setup = new UltrahumanProvider(
      async () => new Response("resource unavailable", { status: 404 }),
    ).authSetup();
    if (!setup.manualToken) throw new Error("expected manual token authentication");

    const error = await setup.manualToken
      .exchangeToken("personal-token")
      .catch((caught: unknown) => caught);

    expect(authFailureReasonFromError(error)).toBeUndefined();
    expect(error).toMatchObject({
      message: "Ultrahuman token validation failed (404). Try again.",
    });
  });

  it("reports a safe error when personal token validation fails unexpectedly", async () => {
    const setup = new UltrahumanProvider(
      async () => new Response("sensitive provider error", { status: 500 }),
    ).authSetup();
    if (!setup.manualToken) throw new Error("expected manual token authentication");

    const error = await setup.manualToken
      .exchangeToken("personal-token")
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      message: "Ultrahuman token validation failed (500). Try again.",
    });
    expect(error instanceof Error ? error.message : "").not.toContain("sensitive provider error");
  });

  it("sync returns an actionable error when no personal token is stored", async () => {
    delete process.env.ULTRAHUMAN_API_TOKEN;
    delete process.env.ULTRAHUMAN_EMAIL;
    const mockFetch = vi.fn<typeof globalThis.fetch>();
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };
    const result = await new UltrahumanProvider(mockFetch).sync(
      new SyncRun({
        db: mockDb,
        window: SyncWindow.fromSince({ since: new Date("2026-01-01") }),
        userId: "user-1",
      }),
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe(
      "No Ultrahuman personal API token found. Connect Ultrahuman in Data Sources.",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    401, 403,
  ])("marks a rejected personal token response (%s) as requiring authentication", async (status) => {
    const { db, spies } = createMockDatabase({
      tokensResult: [
        {
          accessToken: "revoked-personal-token",
          refreshToken: null,
          expiresAt: new Date("2099-12-31T00:00:00.000Z"),
          scopes: "self",
        },
      ],
    });
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response("token rejected", { status });

    const result = await new UltrahumanProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({
          sinceDate: "2026-03-01",
          untilDate: "2026-03-01",
        }),
        userId: "user-1",
      }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(authFailureReasonFromError(result.errors[0]?.cause)).toBe("authentication_failed");
    expect(spies.values).toHaveBeenCalledWith(
      expect.objectContaining({ authFailureReason: "authentication_failed" }),
    );
  });

  it("fails before loading credentials when the sync user is missing", async () => {
    const { db, spies } = createMockDatabase();

    const result = await new UltrahumanProvider().sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({
          sinceDate: "2026-03-01",
          untilDate: "2026-03-01",
        }),
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe("Ultrahuman sync requires an authenticated user ID.");
    expect(spies.select).not.toHaveBeenCalled();
  });

  it("collects a non-authentication daily error without converting it to an auth failure", async () => {
    const { db, spies } = createMockDatabase({
      tokensResult: [
        {
          accessToken: "personal-token",
          refreshToken: null,
          expiresAt: new Date("2099-12-31T00:00:00.000Z"),
          scopes: "self",
        },
      ],
    });
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response("provider validation failed", { status: 500 });

    const result = await new UltrahumanProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({
          sinceDate: "2026-03-01",
          untilDate: "2026-03-01",
        }),
        userId: "user-1",
      }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe(
      "2026-03-01: Ultrahuman API error (500): provider validation failed",
    );
    expect(authFailureReasonFromError(result.errors[0]?.cause)).toBeUndefined();
    expect(spies.values).toHaveBeenCalledWith(
      expect.objectContaining({ authFailureReason: undefined }),
    );
  });
});
