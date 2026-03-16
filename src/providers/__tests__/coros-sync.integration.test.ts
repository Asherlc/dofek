import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { activity, dailyMetrics, oauthToken, sleepSession } from "../../db/schema.ts";
import { ensureProvider, loadTokens, saveTokens } from "../../db/tokens.ts";
import { CorosProvider } from "../coros.ts";

// ============================================================
// Fake COROS API responses
// ============================================================

interface FakeCorosWorkout {
  labelId: string;
  mode: number;
  subMode: number;
  startTime: number;
  endTime: number;
  duration: number;
  distance: number;
  avgHeartRate: number;
  maxHeartRate: number;
  avgSpeed: number;
  maxSpeed: number;
  totalCalories: number;
  avgCadence?: number;
  avgPower?: number;
  maxPower?: number;
  totalAscent?: number;
  totalDescent?: number;
}

function fakeWorkout(overrides: Partial<FakeCorosWorkout> = {}): FakeCorosWorkout {
  return {
    labelId: "coros-w-1001",
    mode: 8, // running
    subMode: 0,
    startTime: 1709280000, // 2024-03-01 08:00:00 UTC
    endTime: 1709283600, // 2024-03-01 09:00:00 UTC
    duration: 3600,
    distance: 10000,
    avgHeartRate: 155,
    maxHeartRate: 178,
    avgSpeed: 2.78,
    maxSpeed: 3.5,
    totalCalories: 650,
    avgCadence: 170,
    ...overrides,
  };
}

interface FakeCorosDailyData {
  date: string;
  steps?: number;
  distance?: number;
  calories?: number;
  restingHr?: number;
  avgHr?: number;
  maxHr?: number;
  sleepDuration?: number;
  deepSleep?: number;
  lightSleep?: number;
  remSleep?: number;
  awakeDuration?: number;
  spo2Avg?: number;
  hrv?: number;
}

function fakeDailyData(overrides: Partial<FakeCorosDailyData> = {}): FakeCorosDailyData {
  return {
    date: "20260301",
    steps: 8500,
    distance: 6200,
    calories: 2100,
    restingHr: 55,
    hrv: 42,
    spo2Avg: 97,
    sleepDuration: 480,
    deepSleep: 90,
    lightSleep: 240,
    remSleep: 120,
    awakeDuration: 30,
    ...overrides,
  };
}

function createMockFetch(
  workouts: FakeCorosWorkout[],
  dailyData: FakeCorosDailyData[],
  opts?: { apiError?: boolean },
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const urlStr = input.toString();

    // Token refresh
    if (urlStr.includes("/oauth2/token")) {
      return Response.json({
        access_token: "refreshed-token",
        refresh_token: "new-refresh",
        expires_in: 7200,
      });
    }

    // Workouts API
    if (urlStr.includes("/v2/coros/sport/list")) {
      if (opts?.apiError) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return Response.json({
        data: workouts,
        message: "OK",
        result: "0000",
      });
    }

    // Daily data API
    if (urlStr.includes("/v2/coros/daily/list")) {
      if (opts?.apiError) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return Response.json({
        data: dailyData,
        message: "OK",
        result: "0000",
      });
    }

    return new Response("Not found", { status: 404 });
  };
}

describe("CorosProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.COROS_CLIENT_ID = "test-client-id";
    process.env.COROS_CLIENT_SECRET = "test-client-secret";
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "coros", "COROS", "https://open.coros.com");
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("syncs workouts into activity table", async () => {
    await saveTokens(ctx.db, "coros", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: null,
    });

    const workouts = [
      fakeWorkout({ labelId: "coros-w-1001", mode: 8 }), // running
      fakeWorkout({ labelId: "coros-w-1002", mode: 9 }), // cycling
    ];

    const provider = new CorosProvider(createMockFetch(workouts, []));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.provider).toBe("coros");
    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "coros"));

    expect(rows).toHaveLength(2);

    const run = rows.find((r) => r.externalId === "coros-w-1001");
    if (!run) throw new Error("expected workout coros-w-1001");
    expect(run.activityType).toBe("running");

    const ride = rows.find((r) => r.externalId === "coros-w-1002");
    if (!ride) throw new Error("expected workout coros-w-1002");
    expect(ride.activityType).toBe("cycling");
  });

  it("syncs daily data into daily_metrics table", async () => {
    await saveTokens(ctx.db, "coros", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: null,
    });

    const daily = [fakeDailyData({ date: "20260305", steps: 10000, restingHr: 52, hrv: 45 })];

    const provider = new CorosProvider(createMockFetch([], daily));
    const result = await provider.sync(ctx.db, new Date("2026-03-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "coros"));

    const march5 = rows.find((r) => r.date === "2026-03-05");
    if (!march5) throw new Error("expected daily metrics for 2026-03-05");
    expect(march5.steps).toBe(10000);
    expect(march5.restingHr).toBe(52);
    expect(march5.hrv).toBe(45);
  });

  it("syncs sleep data into sleep_session table", async () => {
    await saveTokens(ctx.db, "coros", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: null,
    });

    const daily = [
      fakeDailyData({
        date: "20260310",
        steps: 5000,
        restingHr: 58,
        hrv: 40,
        sleepDuration: 420,
        deepSleep: 80,
        lightSleep: 200,
        remSleep: 110,
        awakeDuration: 30,
      }),
    ];

    const provider = new CorosProvider(createMockFetch([], daily));
    const result = await provider.sync(ctx.db, new Date("2026-03-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "coros"));

    const sleepRow = rows.find((r) => r.externalId === "coros-sleep-20260310");
    if (!sleepRow) throw new Error("expected sleep session for 20260310");
    expect(sleepRow.durationMinutes).toBe(420);
    expect(sleepRow.deepMinutes).toBe(80);
    expect(sleepRow.lightMinutes).toBe(200);
    expect(sleepRow.remMinutes).toBe(110);
    expect(sleepRow.awakeMinutes).toBe(30);
  });

  it("refreshes expired tokens and saves new ones", async () => {
    await saveTokens(ctx.db, "coros", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"), // expired
      scopes: null,
    });

    const provider = new CorosProvider(createMockFetch([], []));
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const tokens = await loadTokens(ctx.db, "coros");
    expect(tokens?.accessToken).toBe("refreshed-token");
  });

  it("returns error when no tokens exist", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "coros"));

    const provider = new CorosProvider(createMockFetch([], []));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
    expect(result.recordsSynced).toBe(0);
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "coros", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: null,
    });

    const workouts = [fakeWorkout({ labelId: "coros-w-upsert", mode: 8 })];

    const provider = new CorosProvider(createMockFetch(workouts, []));
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Sync again — should upsert, not duplicate
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "coros"));

    const countOfUpsert = rows.filter((r) => r.externalId === "coros-w-upsert").length;
    expect(countOfUpsert).toBe(1);
  });
});
