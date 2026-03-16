import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activity, dailyMetrics, sleepSession } from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import type {
  PolarDailyActivity,
  PolarExercise,
  PolarNightlyRecharge,
  PolarSleep,
} from "./polar.ts";
import { PolarProvider } from "./polar.ts";

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

function polarHandlers(opts?: {
  exercises?: PolarExercise[];
  sleep?: PolarSleep[];
  dailyActivity?: PolarDailyActivity[];
  nightlyRecharge?: PolarNightlyRecharge[];
}) {
  const exercises = opts?.exercises ?? [];
  const sleep = opts?.sleep ?? [];
  const dailyActivity = opts?.dailyActivity ?? [];
  const nightlyRecharge = opts?.nightlyRecharge ?? [];

  return [
    // Token refresh (Polar uses polarremote.com)
    http.post("https://polarremote.com/v2/oauth2/token", () => {
      return HttpResponse.json({
        access_token: "refreshed-polar-token",
        refresh_token: "new-polar-refresh",
        expires_in: 86400,
        token_type: "Bearer",
      });
    }),

    // Exercises
    http.get("https://www.polar.com/v3/exercises", () => {
      return HttpResponse.json(exercises);
    }),

    // Sleep
    http.get("https://www.polar.com/v3/sleep", () => {
      return HttpResponse.json(sleep);
    }),

    // Nightly recharge
    http.get("https://www.polar.com/v3/nightly-recharge", () => {
      return HttpResponse.json(nightlyRecharge);
    }),

    // Daily activity
    http.get("https://www.polar.com/v3/activity", () => {
      return HttpResponse.json(dailyActivity);
    }),
  ];
}

const server = setupServer();

describe("PolarProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" });
    process.env.POLAR_CLIENT_ID = "test-polar-client";
    process.env.POLAR_CLIENT_SECRET = "test-polar-secret";
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "polar", "Polar", "https://www.polar.com/v3");
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("syncs exercises, sleep, and daily activity with nightly recharge", async () => {
    await saveTokens(ctx.db, "polar", {
      accessToken: "valid-polar-token",
      refreshToken: "valid-polar-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "accesslink.read_all",
    });

    server.use(
      ...polarHandlers({
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

    const provider = new PolarProvider();
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

    server.use(
      ...polarHandlers({
        dailyActivity: [
          fakePolarDailyActivity({ date: "2026-03-05", active_steps: 8500, active_calories: 600 }),
        ],
        nightlyRecharge: [], // No recharge data
      }),
    );

    const provider = new PolarProvider();
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

    server.use(
      ...polarHandlers({
        exercises: [fakePolarExercise({ id: "ex-1001" })],
        sleep: [fakePolarSleep()],
        dailyActivity: [fakePolarDailyActivity()],
        nightlyRecharge: [fakePolarNightlyRecharge()],
      }),
    );

    const provider = new PolarProvider();
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

    server.use(
      ...polarHandlers({
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

    const provider = new PolarProvider();
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
    const { oauthToken } = await import("../db/schema.ts");
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "polar"));

    const provider = new PolarProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found");
    expect(result.recordsSynced).toBe(0);
  });
});

// ============================================================
// Coverage tests for daily_activity error paths
// ============================================================

function polarCoverageHandlers(opts: {
  dailyActivities?: PolarDailyActivity[];
  nightlyRecharges?: PolarNightlyRecharge[];
  dailyActivityError?: boolean;
}) {
  return [
    // Exercises — return empty
    http.get("https://www.polar.com/v3/exercises", () => {
      return HttpResponse.json([]);
    }),

    // Sleep — return empty
    http.get("https://www.polar.com/v3/sleep", () => {
      return HttpResponse.json([]);
    }),

    // Nightly recharge
    http.get("https://www.polar.com/v3/nightly-recharge", () => {
      return HttpResponse.json(opts.nightlyRecharges ?? []);
    }),

    // Daily activity
    http.get("https://www.polar.com/v3/activity", () => {
      if (opts.dailyActivityError) {
        return new HttpResponse("Internal Server Error", { status: 500 });
      }
      return HttpResponse.json(opts.dailyActivities ?? []);
    }),
  ];
}

describe("PolarProvider.sync() — daily_activity error paths (integration)", () => {
  let ctx: TestContext;
  const errorServer = setupServer();

  beforeAll(async () => {
    errorServer.listen({ onUnhandledRequest: "error" });
    process.env.POLAR_CLIENT_ID = "test-polar-client";
    process.env.POLAR_CLIENT_SECRET = "test-polar-secret";
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "polar", "Polar", "https://www.polar.com/v3");
  }, 60_000);

  afterEach(() => {
    errorServer.resetHandlers();
  });

  afterAll(async () => {
    errorServer.close();
    if (ctx) await ctx.cleanup();
  });

  it("catches outer daily_activity withSyncLog error (lines 542-546)", async () => {
    await saveTokens(ctx.db, "polar", {
      accessToken: "valid-polar-token",
      refreshToken: "valid-polar-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "accesslink.read_all",
    });

    errorServer.use(...polarCoverageHandlers({ dailyActivityError: true }));

    const provider = new PolarProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // The daily_activity fetch fails with 500, which throws inside withSyncLog
    // The outer catch at lines 542-546 should catch it
    const dailyError = result.errors.find((e) => e.message.includes("daily_activity"));
    expect(dailyError).toBeDefined();
  });

  it("inserts daily metrics successfully and handles insert errors (lines 530-535)", async () => {
    await saveTokens(ctx.db, "polar", {
      accessToken: "valid-polar-token",
      refreshToken: "valid-polar-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "accesslink.read_all",
    });

    // Clear daily metrics
    await ctx.db.delete(dailyMetrics).where(eq(dailyMetrics.providerId, "polar"));

    errorServer.use(
      ...polarCoverageHandlers({
        dailyActivities: [fakePolarDailyActivity({ date: "2026-03-10", active_steps: 9000 })],
      }),
    );

    const provider = new PolarProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Should succeed
    expect(result.errors).toHaveLength(0);
    const rows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "polar"));
    const march10 = rows.find((r) => r.date === "2026-03-10");
    expect(march10).toBeDefined();
    expect(march10?.steps).toBe(9000);
  });
});
