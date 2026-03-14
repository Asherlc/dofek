import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { activity, dailyMetrics, sleepSession } from "../../db/schema.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import type {
  PolarDailyActivity,
  PolarExercise,
  PolarNightlyRecharge,
  PolarSleep,
} from "../polar.ts";
import { PolarProvider } from "../polar.ts";

function fakePolarExercise(overrides: Partial<PolarExercise> = {}): PolarExercise {
  return {
    id: "ex-1001",
    upload_time: "2026-03-01T11:30:00Z",
    polar_user: "https://www.polar.com/v3/users/12345",
    device: "Polar Vantage V3",
    start_time: "2026-03-01T10:00:00Z",
    duration: "PT1H15M30S",
    calories: 780,
    distance: 13500,
    heart_rate: { average: 152, maximum: 181 },
    sport: "RUNNING",
    has_route: true,
    detailed_sport_info: "Running",
    ...overrides,
  };
}

function fakePolarSleep(overrides: Partial<PolarSleep> = {}): PolarSleep {
  return {
    polar_user: "https://www.polar.com/v3/users/12345",
    date: "2026-03-01",
    sleep_start_time: "2026-02-28T22:45:00Z",
    sleep_end_time: "2026-03-01T06:30:00Z",
    device_id: "A1B2C3D4",
    continuity: 3.2,
    continuity_class: 3,
    light_sleep: 13200, // 220m in seconds
    deep_sleep: 5100, // 85m
    rem_sleep: 6000, // 100m
    unrecognized_sleep_stage: 0,
    sleep_score: 78,
    total_interruption_duration: 2400, // 40m
    sleep_charge: 3,
    sleep_goal_minutes: 480,
    sleep_rating: 3,
    hypnogram: {},
    ...overrides,
  };
}

function fakePolarDailyActivity(overrides: Partial<PolarDailyActivity> = {}): PolarDailyActivity {
  return {
    polar_user: "https://www.polar.com/v3/users/12345",
    date: "2026-03-01",
    created: "2026-03-01T23:59:00Z",
    calories: 2400,
    active_calories: 850,
    duration: "PT14H30M",
    active_steps: 11200,
    ...overrides,
  };
}

function fakePolarNightlyRecharge(
  overrides: Partial<PolarNightlyRecharge> = {},
): PolarNightlyRecharge {
  return {
    polar_user: "https://www.polar.com/v3/users/12345",
    date: "2026-03-01",
    heart_rate_avg: 52,
    beat_to_beat_avg: 1154,
    heart_rate_variability_avg: 48.5,
    breathing_rate_avg: 14.8,
    nightly_recharge_status: 3,
    ans_charge: 6.2,
    ans_charge_status: 3,
    ...overrides,
  };
}

function createMockFetch(opts?: {
  exercises?: PolarExercise[];
  sleep?: PolarSleep[];
  dailyActivity?: PolarDailyActivity[];
  nightlyRecharge?: PolarNightlyRecharge[];
}): typeof globalThis.fetch {
  const exercises = opts?.exercises ?? [];
  const sleep = opts?.sleep ?? [];
  const dailyActivity = opts?.dailyActivity ?? [];
  const nightlyRecharge = opts?.nightlyRecharge ?? [];

  return (async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const urlStr = input.toString();

    // Token refresh (Polar uses polarremote.com)
    if (urlStr.includes("polarremote.com")) {
      return Response.json({
        access_token: "refreshed-polar-token",
        refresh_token: "new-polar-refresh",
        expires_in: 86400,
        token_type: "Bearer",
      });
    }

    // Exercises
    if (urlStr.includes("/v3/exercises")) {
      return Response.json(exercises);
    }

    // Sleep
    if (urlStr.includes("/v3/sleep")) {
      return Response.json(sleep);
    }

    // Nightly recharge
    if (urlStr.includes("/v3/nightly-recharge")) {
      return Response.json(nightlyRecharge);
    }

    // Daily activity
    if (urlStr.includes("/v3/activity")) {
      return Response.json(dailyActivity);
    }

    return new Response("Not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

describe("PolarProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.POLAR_CLIENT_ID = "test-polar-client";
    process.env.POLAR_CLIENT_SECRET = "test-polar-secret";
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "polar", "Polar", "https://www.polar.com/v3");
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("syncs exercises, sleep, and daily activity with nightly recharge", async () => {
    await saveTokens(ctx.db, "polar", {
      accessToken: "valid-polar-token",
      refreshToken: "valid-polar-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "accesslink.read_all",
    });

    const provider = new PolarProvider(
      createMockFetch({
        exercises: [
          fakePolarExercise({ id: "ex-1001" }),
          fakePolarExercise({
            id: "ex-1002",
            sport: "CYCLING",
            start_time: "2026-03-02T15:00:00Z",
            detailed_sport_info: "Road cycling",
            duration: "PT2H10M",
            distance: 55000,
            calories: 1200,
          }),
        ],
        sleep: [fakePolarSleep()],
        dailyActivity: [fakePolarDailyActivity()],
        nightlyRecharge: [fakePolarNightlyRecharge()],
      }),
    );

    const since = new Date("2026-02-01T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    expect(result.provider).toBe("polar");
    expect(result.errors).toHaveLength(0);

    // Verify exercises -> activity
    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "polar"));
    expect(activityRows).toHaveLength(2);

    const run = activityRows.find((r) => r.externalId === "ex-1001");
    if (!run) throw new Error("expected exercise ex-1001");
    expect(run.activityType).toBe("running");
    expect(run.name).toBe("Running");

    const ride = activityRows.find((r) => r.externalId === "ex-1002");
    if (!ride) throw new Error("expected exercise ex-1002");
    expect(ride.activityType).toBe("cycling");

    // Verify sleep
    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "polar"));
    expect(sleepRows).toHaveLength(1);

    const sleepRecord = sleepRows[0];
    if (!sleepRecord) throw new Error("expected sleep session");
    expect(sleepRecord.deepMinutes).toBe(85);
    expect(sleepRecord.lightMinutes).toBe(220);
    expect(sleepRecord.remMinutes).toBe(100);
    expect(sleepRecord.awakeMinutes).toBe(40);

    // Verify daily metrics (with nightly recharge data merged)
    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "polar"));
    expect(dailyRows).toHaveLength(1);

    const daily = dailyRows[0];
    if (!daily) throw new Error("expected daily metrics");
    expect(daily.steps).toBe(11200);
    expect(daily.activeEnergyKcal).toBe(850);
    expect(daily.restingHr).toBe(52);
    expect(daily.hrv).toBeCloseTo(48.5);
    expect(daily.respiratoryRateAvg).toBeCloseTo(14.8);
  });

  it("syncs daily activity without nightly recharge data", async () => {
    await saveTokens(ctx.db, "polar", {
      accessToken: "valid-polar-token",
      refreshToken: "valid-polar-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "accesslink.read_all",
    });

    // Clear previous data
    await ctx.db.delete(dailyMetrics).where(eq(dailyMetrics.providerId, "polar"));

    const provider = new PolarProvider(
      createMockFetch({
        dailyActivity: [
          fakePolarDailyActivity({ date: "2026-03-05", active_steps: 8500, active_calories: 600 }),
        ],
        nightlyRecharge: [], // No recharge data
      }),
    );

    const since = new Date("2026-02-01T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    expect(result.errors).toHaveLength(0);

    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "polar"));
    const march5 = dailyRows.find((r) => r.date === "2026-03-05");
    if (!march5) throw new Error("expected daily metrics for 2026-03-05");
    expect(march5.steps).toBe(8500);
    expect(march5.restingHr).toBeNull();
    expect(march5.hrv).toBeNull();
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "polar", {
      accessToken: "valid-polar-token",
      refreshToken: "valid-polar-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "accesslink.read_all",
    });

    const provider = new PolarProvider(
      createMockFetch({
        exercises: [fakePolarExercise({ id: "ex-1001" })],
        sleep: [fakePolarSleep()],
        dailyActivity: [fakePolarDailyActivity()],
        nightlyRecharge: [fakePolarNightlyRecharge()],
      }),
    );

    const since = new Date("2026-02-01T00:00:00Z");
    await provider.sync(ctx.db, since);
    await provider.sync(ctx.db, since);

    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "polar"));
    const countOf1001 = activityRows.filter((r) => r.externalId === "ex-1001").length;
    expect(countOf1001).toBe(1);
  });

  it("filters out exercises before since date", async () => {
    await saveTokens(ctx.db, "polar", {
      accessToken: "valid-polar-token",
      refreshToken: "valid-polar-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "accesslink.read_all",
    });

    // Clear previous activity data
    await ctx.db.delete(activity).where(eq(activity.providerId, "polar"));

    const provider = new PolarProvider(
      createMockFetch({
        exercises: [
          fakePolarExercise({
            id: "ex-old",
            start_time: "2025-12-01T10:00:00Z", // before since
          }),
          fakePolarExercise({
            id: "ex-new",
            start_time: "2026-03-10T10:00:00Z", // after since
          }),
        ],
      }),
    );

    const since = new Date("2026-03-01T00:00:00Z");
    await provider.sync(ctx.db, since);

    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "polar"));
    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]?.externalId).toBe("ex-new");
  });

  it("returns error when no tokens exist", async () => {
    const { oauthToken } = await import("../../db/schema.ts");
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "polar"));

    const provider = new PolarProvider(createMockFetch());
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found");
    expect(result.recordsSynced).toBe(0);
  });
});
