import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dailyMetrics, sleepSession } from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { UltrahumanProvider } from "./ultrahuman.ts";

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
// MSW handler factory
// ============================================================

interface UltrahumanMockOptions {
  dayResponses?: Record<string, UltrahumanMetric[]>;
  apiError?: boolean;
  apiErrorDate?: string;
}

function ultrahumanHandlers(opts: UltrahumanMockOptions = {}) {
  const dayResponses = opts.dayResponses ?? {};

  return [
    http.get("https://partner.ultrahuman.com/api/v1/partner/daily_metrics", ({ request }) => {
      const url = new URL(request.url);
      const date = url.searchParams.get("date") ?? "";

      // Simulate per-date API errors
      if (opts.apiError || (opts.apiErrorDate && date === opts.apiErrorDate)) {
        return new HttpResponse("Internal Server Error", { status: 500 });
      }

      const metrics = dayResponses[date];
      if (metrics) {
        return HttpResponse.json(fakeUltrahumanDailyResponse(date, metrics));
      }

      // No data for this date
      return HttpResponse.json(fakeUltrahumanDailyResponse(date, []));
    }),
  ];
}

const server = setupServer();

// ============================================================
// Tests
// ============================================================

describe("UltrahumanProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.ULTRAHUMAN_API_TOKEN = "test-ultrahuman-token";
    process.env.ULTRAHUMAN_EMAIL = "test@example.com";
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: "error" });
    await ensureProvider(
      ctx.db,
      "ultrahuman",
      "Ultrahuman",
      "https://partner.ultrahuman.com/api/v1",
    );
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("syncs daily metrics and sleep sessions day-by-day", async () => {
    await saveTokens(ctx.db, "ultrahuman", {
      accessToken: "test-token",
      refreshToken: null,
      expiresAt: new Date("2099-12-31T23:59:59Z"),
      scopes: "email:test@example.com",
    });

    server.use(
      ...ultrahumanHandlers({
        dayResponses: {
          "2026-03-14": fakeFullDayMetrics(),
          "2026-03-15": fakeMetricsOnlyDay(),
        },
      }),
    );

    const provider = new UltrahumanProvider();

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

    server.use(
      ...ultrahumanHandlers({
        dayResponses: {
          "2026-03-14": fakeFullDayMetrics(),
        },
      }),
    );

    const provider = new UltrahumanProvider();

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

      server.use(
        http.get("https://partner.ultrahuman.com/api/v1/partner/daily_metrics", ({ request }) => {
          capturedAuthHeader = request.headers.get("Authorization");
          const url = new URL(request.url);
          const date = url.searchParams.get("date") ?? "";
          return HttpResponse.json(fakeUltrahumanDailyResponse(date, []));
        }),
      );

      const provider = new UltrahumanProvider();
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
      const { oauthToken } = await import("../db/schema.ts");
      await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "ultrahuman"));

      const provider = new UltrahumanProvider();
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

    server.use(
      ...ultrahumanHandlers({
        dayResponses: {
          "2026-03-14": fakeFullDayMetrics(),
          // March 15 will fail
        },
        apiErrorDate: "2026-03-15",
      }),
    );

    const provider = new UltrahumanProvider();

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

    server.use(
      ...ultrahumanHandlers({
        dayResponses: {
          // March 15 has sleep only — no daily metrics values
          "2026-03-15": fakeSleepOnlyDay(),
        },
      }),
    );

    const provider = new UltrahumanProvider();

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
