import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { dailyMetrics, sleepSession } from "../../db/schema.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import { UltrahumanProvider } from "../ultrahuman.ts";

// ============================================================
// Fake Ultrahuman API response builders
// ============================================================

interface UltrahumanMetric {
  type: string;
  object: Record<string, unknown>;
}

function fakeUltrahumanDailyResponse(date: string, metrics: UltrahumanMetric[] = []) {
  return {
    data: {
      metrics: {
        [date]: metrics,
      },
    },
    error: null,
    status: 200,
  };
}

function fakeFullDayMetrics(): UltrahumanMetric[] {
  return [
    { type: "night_rhr", object: { avg: 52 } },
    { type: "avg_sleep_hrv", object: { value: 45.5 } },
    { type: "steps", object: { value: 8500 } },
    { type: "vo2_max", object: { value: 48.2 } },
    { type: "active_minutes", object: { value: 65 } },
    { type: "body_temperature", object: { value: 36.7 } },
    {
      type: "sleep",
      object: {
        quick_metrics: [
          { type: "total_sleep", value: 27000 }, // 450 minutes = 7.5h
          { type: "sleep_index", value: 85 },
        ],
      },
    },
  ];
}

function fakeMetricsOnlyDay(): UltrahumanMetric[] {
  return [
    { type: "avg_rhr", object: { value: 55 } },
    { type: "steps", object: { value: 12000 } },
  ];
}

function fakeSleepOnlyDay(): UltrahumanMetric[] {
  return [
    {
      type: "sleep",
      object: {
        quick_metrics: [
          { type: "total_sleep", value: 21600 }, // 360 minutes = 6h
          { type: "sleep_index", value: 72 },
        ],
      },
    },
  ];
}

// ============================================================
// Mock fetch factory
// ============================================================

interface UltrahumanMockOptions {
  dayResponses?: Record<string, UltrahumanMetric[]>;
  apiError?: boolean;
  apiErrorDate?: string;
}

function createMockFetch(opts: UltrahumanMockOptions = {}): typeof globalThis.fetch {
  const dayResponses = opts.dayResponses ?? {};

  return async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const urlStr = input.toString();

    // Daily metrics endpoint
    if (urlStr.includes("/api/v1/partner/daily_metrics")) {
      const url = new URL(urlStr);
      const date = url.searchParams.get("date") ?? "";

      // Simulate per-date API errors
      if (opts.apiError || (opts.apiErrorDate && date === opts.apiErrorDate)) {
        return new Response("Internal Server Error", { status: 500 });
      }

      const metrics = dayResponses[date];
      if (metrics) {
        return Response.json(fakeUltrahumanDailyResponse(date, metrics));
      }

      // No data for this date
      return Response.json(fakeUltrahumanDailyResponse(date, []));
    }

    return new Response("Not found", { status: 404 });
  };
}

// ============================================================
// Tests
// ============================================================

describe("UltrahumanProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.ULTRAHUMAN_API_TOKEN = "test-ultrahuman-token";
    process.env.ULTRAHUMAN_EMAIL = "test@example.com";
    ctx = await setupTestDatabase();
    await ensureProvider(
      ctx.db,
      "ultrahuman",
      "Ultrahuman",
      "https://partner.ultrahuman.com/api/v1",
    );
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("syncs daily metrics and sleep sessions day-by-day", async () => {
    await saveTokens(ctx.db, "ultrahuman", {
      accessToken: "test-token",
      refreshToken: null,
      expiresAt: new Date("2099-12-31T23:59:59Z"),
      scopes: "email:test@example.com",
    });

    const provider = new UltrahumanProvider(
      createMockFetch({
        dayResponses: {
          "2026-03-14": fakeFullDayMetrics(),
          "2026-03-15": fakeMetricsOnlyDay(),
        },
      }),
    );

    // Sync from March 14 to today (March 15)
    const since = new Date("2026-03-14T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    expect(result.provider).toBe("ultrahuman");
    expect(result.errors).toHaveLength(0);

    // Verify daily metrics — 2 days with metrics data
    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "ultrahuman"));
    expect(dailyRows).toHaveLength(2);

    const march14 = dailyRows.find((r) => r.date === "2026-03-14");
    if (!march14) throw new Error("expected daily metrics for 2026-03-14");
    expect(march14.restingHr).toBe(52);
    expect(march14.hrv).toBeCloseTo(45.5);
    expect(march14.steps).toBe(8500);
    expect(march14.vo2max).toBeCloseTo(48.2);
    expect(march14.exerciseMinutes).toBe(65);
    expect(march14.skinTempC).toBeCloseTo(36.7);

    const march15 = dailyRows.find((r) => r.date === "2026-03-15");
    if (!march15) throw new Error("expected daily metrics for 2026-03-15");
    expect(march15.restingHr).toBe(55);
    expect(march15.steps).toBe(12000);

    // Verify sleep session — only March 14 has sleep data
    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "ultrahuman"));
    expect(sleepRows).toHaveLength(1);

    const sleepRecord = sleepRows[0];
    if (!sleepRecord) throw new Error("expected sleep session");
    expect(sleepRecord.externalId).toBe("ultrahuman-sleep-2026-03-14");
    expect(sleepRecord.durationMinutes).toBe(450); // 27000 / 60

    // recordsSynced = 2 daily + 1 sleep = 3
    expect(result.recordsSynced).toBe(3);
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "ultrahuman", {
      accessToken: "test-token",
      refreshToken: null,
      expiresAt: new Date("2099-12-31T23:59:59Z"),
      scopes: "email:test@example.com",
    });

    const provider = new UltrahumanProvider(
      createMockFetch({
        dayResponses: {
          "2026-03-14": fakeFullDayMetrics(),
        },
      }),
    );

    const since = new Date("2026-03-14T00:00:00Z");
    await provider.sync(ctx.db, since);
    await provider.sync(ctx.db, since);

    // Should not duplicate
    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.externalId, "ultrahuman-sleep-2026-03-14"));
    expect(sleepRows).toHaveLength(1);
  });

  it("uses stored tokens from DB rather than env vars", async () => {
    // Clear env vars to prove DB tokens are used
    const savedToken = process.env.ULTRAHUMAN_API_TOKEN;
    const savedEmail = process.env.ULTRAHUMAN_EMAIL;
    delete process.env.ULTRAHUMAN_API_TOKEN;
    delete process.env.ULTRAHUMAN_EMAIL;

    try {
      await saveTokens(ctx.db, "ultrahuman", {
        accessToken: "db-stored-token",
        refreshToken: null,
        expiresAt: new Date("2099-12-31T23:59:59Z"),
        scopes: "email:dbuser@example.com",
      });

      let capturedAuthHeader: string | null = null;
      const capturingFetch: typeof globalThis.fetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const urlStr = input.toString();
        if (urlStr.includes("/api/v1/partner/daily_metrics")) {
          // @ts-expect-error -- test: HeadersInit narrowed to Record for test assertions
          const headers: Record<string, string> | undefined = init?.headers;
          capturedAuthHeader = headers?.Authorization ?? null;
          return Response.json(fakeUltrahumanDailyResponse("2026-03-15", []));
        }
        return new Response("Not found", { status: 404 });
      };

      const provider = new UltrahumanProvider(capturingFetch);
      await provider.sync(ctx.db, new Date("2026-03-15T00:00:00Z"));

      expect(capturedAuthHeader).toBe("db-stored-token");
    } finally {
      process.env.ULTRAHUMAN_API_TOKEN = savedToken;
      process.env.ULTRAHUMAN_EMAIL = savedEmail;
    }
  });

  it("returns error when no token or email is available", async () => {
    const savedToken = process.env.ULTRAHUMAN_API_TOKEN;
    const savedEmail = process.env.ULTRAHUMAN_EMAIL;
    delete process.env.ULTRAHUMAN_API_TOKEN;
    delete process.env.ULTRAHUMAN_EMAIL;

    try {
      // Delete stored tokens
      const { oauthToken } = await import("../../db/schema.ts");
      await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "ultrahuman"));

      const provider = new UltrahumanProvider(createMockFetch());
      const result = await provider.sync(ctx.db, new Date("2026-03-14T00:00:00Z"));

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toContain("token and email required");
      expect(result.recordsSynced).toBe(0);
    } finally {
      process.env.ULTRAHUMAN_API_TOKEN = savedToken;
      process.env.ULTRAHUMAN_EMAIL = savedEmail;
    }
  });

  it("continues syncing other days when one day API call fails", async () => {
    await saveTokens(ctx.db, "ultrahuman", {
      accessToken: "test-token",
      refreshToken: null,
      expiresAt: new Date("2099-12-31T23:59:59Z"),
      scopes: "email:test@example.com",
    });

    // Clear existing data
    await ctx.db.delete(dailyMetrics).where(eq(dailyMetrics.providerId, "ultrahuman"));
    await ctx.db.delete(sleepSession).where(eq(sleepSession.providerId, "ultrahuman"));

    const provider = new UltrahumanProvider(
      createMockFetch({
        dayResponses: {
          "2026-03-14": fakeFullDayMetrics(),
          // March 15 will fail
        },
        apiErrorDate: "2026-03-15",
      }),
    );

    const since = new Date("2026-03-14T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    // March 14 should still sync successfully
    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "ultrahuman"));
    expect(dailyRows).toHaveLength(1);
    expect(dailyRows[0]?.date).toBe("2026-03-14");

    // There should be an error for March 15
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    const errorForDate = result.errors.find((e) => e.message.includes("2026-03-15"));
    expect(errorForDate).toBeDefined();
  });

  it("skips days with no metric data", async () => {
    await saveTokens(ctx.db, "ultrahuman", {
      accessToken: "test-token",
      refreshToken: null,
      expiresAt: new Date("2099-12-31T23:59:59Z"),
      scopes: "email:test@example.com",
    });

    // Clear existing data
    await ctx.db.delete(dailyMetrics).where(eq(dailyMetrics.providerId, "ultrahuman"));
    await ctx.db.delete(sleepSession).where(eq(sleepSession.providerId, "ultrahuman"));

    const provider = new UltrahumanProvider(
      createMockFetch({
        dayResponses: {
          // March 15 has sleep only — no daily metrics values
          "2026-03-15": fakeSleepOnlyDay(),
        },
      }),
    );

    const since = new Date("2026-03-15T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    // Should only have sleep, no daily metrics
    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "ultrahuman"));
    // Sleep-only day doesn't have restingHr/hrv/steps/vo2max, so daily metrics won't be upserted
    expect(dailyRows).toHaveLength(0);

    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.externalId, "ultrahuman-sleep-2026-03-15"));
    expect(sleepRows).toHaveLength(1);
    expect(sleepRows[0]?.durationMinutes).toBe(360);

    // 1 sleep record
    expect(result.recordsSynced).toBe(1);
  });
});
